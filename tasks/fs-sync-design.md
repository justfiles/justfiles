# Filesystem and sync design

Build a complete local filesystem first. Add synchronization through an accepted filesystem plus a durable pending overlay, with one logical authority per shared tree. Use the same client engine and persistence format across runtimes. This document defines the target architecture; implementation and migration are separate work.

**Glossary**

| Term | Meaning |
| --- | --- |
| Tree | One shared filesystem with one root: one authority history, one Store on the client, one `.sync`. Its identity is the root's entity ID. |
| Replica | One device's copy of a tree, with a permanent replica ID the engine generates on first open. |
| Authority | The one service per tree that accepts or rejects proposals, orders accepted changes, and keeps the history and content. |
| Bootstrap | Fetching a complete snapshot of the tree at one cursor, to start from or to recover when history has expired. |
| Cursor | An opaque bookmark in a tree's history. The engine stores the cursor of the last batch it installed and asks for changes after it. |
| Generation | A replica's current bootstrap generation. Every proposal carries it; an old generation is refused until the replica bootstraps again. |
| Entity | A replicated file, directory or symlink with a global ID that survives moves. A `Node` is the local counterpart inside a Store or Volume. |
| Revision | A hash of an entity's replicated state, including identity, location and mode. Equal states have equal revisions. |
| Hash | SHA-256 of a file's bytes; how content is referenced everywhere. |
| Edit | One local journal record: the operations of one write through the view, with their before-state and dependencies. |
| Operation | One create, update or delete addressed by entity ID. Edits and proposals are made of them. |
| Proposal | One request to the authority: operations plus the exact base they were authored against, under a generation, with an immutable ID. |
| Outcome | The authority's verdict on a proposal: accepted with a cursor, rejected with a reason and cursor, or bootstrap required. |
| Change, batch | What the authority actually committed: full entity states or deletions, grouped per accepted proposal and delivered in cursor order. |
| Accepted | The last authority state this replica has installed. Lives at the storage root. |
| Pending | Local edits not yet retired by an installed acceptance. Lives under `.sync`. |
| View | `engine.volume`: accepted state with pending edits applied. The only filesystem consumers use. |
| Conflict | A preserved version: local work the authority refused, kept with its bytes until dismissed. Never blocks sync. |
| Detach, trash, purge | Removal sets an entity's parent to null; the engine keeps it under `.sync/trash`; the authority deletes it after its retention period. |
| Reconcile | The idempotent loop that makes storage match the target state. Installation, bootstrap and crash recovery are all one reconcile. |

**Why a redesign**

The current `packages/fs` syncs one replicated table between two Stores that share a seam, where a remote peer is just another Store. Rows carry a version with an author tag, deletions are tombstone rows in the same table, private subtrees are mount rows, and the host keeps the replica ID, both cursors and a discard flag in slots of its own. Writes are guarded by compare-and-set against whatever the peer holds at push time, which was already found insufficient: a guard taken at push time cannot tell a write that is merely stale from one that competes with another author, so the push guard was removed and conflicts were left to structural recovery rules such as revive, rename and re-parent, plus two whole-store resets. The model has no durable record of what state an edit was authored against, so it cannot preserve a losing edit, cannot explain a rejection, and cannot keep a replica usable while its own history is unsettled.

This design keeps a durable accepted baseline and a journal of pending intent with the exact base each edit was authored against, one filesystem-aware authority that rebases by identity and decides atomically, a view that always converges to the authority while losing work is preserved with its bytes, and engine-owned state beside the files instead of in the replicated table or the host. Store and Volume become plain filesystem primitives with no sync vocabulary. The old package stays until the new one is implemented and migration is designed.

**Responsibilities**

| Part | Owns |
| --- | --- |
| `Volume` | Public filesystem operations: paths, file contents, directories, links, metadata, change notification. |
| `Store` | Smaller filesystem primitives over local entities, implemented by each backend. |
| `Node` | A filesystem entity and its local identity. No replication revisions, cursors, or tombstones. |
| Filesystem sync engine | Replicated identity, accepted baseline, pending overlay, preserved versions, transfers, and recovery. |
| Authority | Filesystem-aware rebasing, tree invariants, atomic acceptance, ordering, and retained history. |

Keep `Volume` over `Store`. Store primitives express filesystem actions, including their atomicity and errors; they do not promise arbitrary atomic row batches. The sync engine composes ordinary Volumes and exposes its own view. Neither base interface depends on synchronization.

`NodeSpec.mode` represents owner/group/other rwx bits (`0..0o777`) for files and directories; symlinks have a fixed `0o777` mode. `Node` and `EntityData` share this representation. Special bits, ownership, and host access enforcement are outside the model. Backends preserve the modeled mode or reject unsupported writes; native permission handling stays behind the backend. `Store.create` receives the mode explicitly and never defaults it: Volume creates files with `FILE_MODE` (`0o644`) and directories with `DIR_MODE` (`0o755`), an overwrite through `writeFile` keeps the existing mode, and no layer applies a umask, because the value is replicated verbatim and a umask default such as `0o666` would install world-writable files on every native replica. A created entity's mode travels in its create operation; a later `chmod` collapses into that create when both are still pending.

`Store.update(id, { mode?, mtimeNs? })` sets writable metadata on files and directories. Volume resolves paths and symlinks for `chmod` and `utimes` before calling it. Omitted fields stay unchanged, an empty update on an existing file or directory does nothing, and backend timestamp precision may round values. It does not flush or guarantee atomicity across fields; failures may leave partial changes. `write` maintains size and automatic mtime; explicit metadata overrides follow the content write.

Node IDs are opaque and scoped to their Store or Volume. The engine maps backing IDs to globally unique replicated IDs, including parent references. Its view also represents pending entries that have no accepted backing node yet; their visible IDs survive acceptance. Replicated IDs survive moves and are never intentionally reused. The authority supplies the shared root identity.

**Composition and persistence**

`synced` receives one `storage: Volume` and an `authority: Authority`. It returns a controller whose `volume` is the filesystem consumers use. Status, preserved versions, explicit sync passes, and shutdown belong to the controller. Volume flushing confirms local durability; it never waits for authority acceptance. Closing sync releases only resources it owns.

Storage holds the last installed authority tree at its root and private state under the reserved root entry `.sync`: replica/tree identity, accepted metadata and cursor, ID mappings, pending operations and bytes, local metadata, conflicts, and recovery records. One private implementation manages that state through filesystem operations, without backend database access. A reader holding the storage Volume directly sees accepted files plus the hidden directory, like a checkout beside its `.git`, and never pending work.

`.sync` is reserved by the protocol, not by convention. The view hides it: listing the root omits it, reads under it fail with `ENOENT`, and creating, renaming into, or removing it fails with `EPERM`. The authority rejects any root child with that name as `invalid-tree`, so no incoming change can target it. Persisted state records the authority root and a replica identity the engine generates on first open. Opening compares the saved root with `Authority.root` and rejects a mismatch with `TREE_MISMATCH`, offline included; pending work is never retargeted to another tree.

The shared tree has no mount points: one authority, one root, one Store. A host that wants private subtrees beside synced data composes Volumes with a path router, an ordinary wrapper that maps prefixes to Volumes, strips the prefix, forwards every method, and forwards `watch` with path translation. The private Volume is never handed to the engine, so the authority never learns its paths and no remote replica can create entries under them, which is the property mount rows provided before. A mounted prefix shadows the underlying path, and a rename across router boundaries rejects with `EXDEV`. The private Volume may live anywhere, including a directory physically inside the storage folder, since the engine ignores entries it does not own. The router is a host concern, not part of this package.

One active engine owns writes to storage, and the engine enforces it with a lease at `.sync/lock` holding an owner token and an expiry. Opening creates the lease exclusively through `Store.create`, so `EEXIST` means another owner and opening rejects with `LOCKED`. An expired lease is taken over by renaming it under `.sync/tmp` and creating fresh; rename is atomic, so of two racing takers exactly one succeeds, and the create resolves any remaining race. The engine renews the lease while open and removes it on close. If a renewal finds the lease missing or owned by another token, the engine stops writing, reports a `LOCKED` issue, and sync passes reject until close; pending work stays in the journal for the next owner. Renewal interval and expiry are implementation constants, with the expiry several times the interval so a paused tab keeps its lease under normal scheduling. Hosts may still route tabs through one owner for convenience, but correctness does not depend on it. All consumer reads and writes go through `engine.volume`; direct storage access bypasses its view and consistency guarantees.

**Startup**

Opening never uses the network. Storage without `.sync` gets the private layout and a replica identity and returns an uninitialized replica: status reports the phase, every `engine.volume` call rejects with `UNINITIALIZED`, and nothing exists to lose. Entries already present are left alone and stay invisible to the view: pre-existing files carry no shared identity, and adopting them is a migration tool's job, copying through `engine.volume` after bootstrap. Managed storage replays its journal and recovers before returning.

The engine never touches storage entries it does not own. Its view of the tree is the authority's entity map, not a scan of the directory, so a `.DS_Store`, an editor's temporary file, or a host's private directory placed inside storage is never synced, never removed, and never visible through the view. A native backend cannot work without this rule. Its one consequence is a collision: if an incoming entity's name is occupied by such an entry, reconcile cannot install it and reports an error issue that persists until the host resolves the name; nothing is overwritten.

Bootstrap is one path. `sync()` runs it when no authority cursor is installed or when the authority answers bootstrap-required, and an interrupted bootstrap resumes on the next pass. Completing the first bootstrap ends the uninitialized phase.

**Local view and writes**

The visible filesystem is the accepted tree with pending intent and local metadata applied. Derive each changed component from the edit's original base, including the complete intended location tuple; leave untouched components at their accepted values. Reads, listings, paths, renames, deletions, links, and metadata all use this view. Preserve tree invariants.

For a write through `engine.volume`:

1. Validate the operation against the view.
2. Persist required content and publish the edit or local metadata event in the state journal.
3. Expose the updated view and return. Submit the edit once its local prerequisites have been accepted and installed, or together with them when the rules below allow.

**Change notification**

`Volume.watch` is one wake-style primitive: the entry at a path, its immediate entries for a directory, or everything beneath it with `recursive`. A delivery says the entry or listing is stale and carries no per-change detail, so bursts coalesce into bounded deliveries with a guaranteed trailing one. The event carries only its source, `local` or `remote`, so an app can ignore its own writes.

The implementation lives in whichever Volume performs the writes, because the Volume resolves every path before touching the Store and therefore knows exactly which nodes and parent entries a call touched. `volume(store)` wakes after its own mutating calls; two Volume instances over one Store do not observe each other, which is the single-writer rule again. The view wakes `local` once a write is persisted and `remote` for every entry whose visible state changed when an installation completes, including the removal of refused local work. The first bootstrap wakes the root recursively once. Wrappers such as a path router forward watch with path translation; a proxy across a process or frame boundary needs one subscription channel. Watching storage directly shows accepted installs as local writes plus `.sync` activity; consumers watch the view. External writers to a backend remain invisible, as the ownership rules already require.

**Removal is detachment**

`rm` through the view, recursive or not, records one update that sets the entity's parent to null. Its base is that entity's before-state alone; the subtree keeps its identities and parent references and is never enumerated. The proposal, the journal record, the authority's check and the install are all O(1), and a rejected detach involves one entity. Pending creates beneath the path keep their dependencies and simply land in the detached tree; the detach does not depend on them.

Detached entities are unreachable from the root by construction, so the view needs no filtering rule, no reserved trash name exists in the shared tree, and detached entities have no siblings to collide with. Only the subtree root has a null parent; its descendants keep their parents and are detached by ancestry, so the same reachability walk that builds the view places unreachable entities in the trash. Locally the engine keeps them under `.sync/trash/<entityId>`. Restoring is one move back under a parent. The engine may discard a detached subtree's bytes locally and refetch them on restore, since the authority retains content for detached entities until purge. Browsing and restoring the trash are deferred to a later interface.

Storage is one Store. Detachment is O(1) only because the engine renames the accepted entry into `.sync/trash`, and journal publication renames from `.sync/tmp` into place; a rename across stores rejects with `EXDEV` and cannot be recovered. The engine does not probe for this at open; a cross-store rename surfaces as an issue on the first removal or publication, and the host fixes the wiring.

Every replica installs a detachment. In the feed it is a put whose parent is null and whose id is not the root, installed by renaming the accepted entry into the trash; a purge is deletes, installed by removing trash entries. Bootstrap includes detached entities and their descendants as metadata in the entity map, creates nothing under the trash for them, and fetches no content. A put that re-attaches a detached entity is installed like any incoming change: required bytes are fetched and verified first, whether they were dropped locally or never present. Trash bytes are therefore present when this replica performed or installed the detachment and optional afterwards; nothing reads them except a restore or a future trash interface.

Purging is the authority's retention policy, not a client operation. A purge deletes detached entities and arrives at replicas as ordinary deletion changes, installed incrementally. The `delete` operation therefore describes purges and requires an entity without children; clients do not author it for removal.

Concurrent work beneath a detached directory combines by identity like any ancestor move: it rides into the detached tree and stays recoverable, rather than rejecting the removal. That replica sees its entry vanish from the visible tree. The engine may raise a local notice when an incoming change targets a subtree it has pending-detached; the authority does not.

The plain `volume(store)` has nothing to detach into. Its recursive removal walks bottom-up through single Store removes, stops at the first failure, and leaves the rest, consistent with the base contract.

Local edits leave accepted files unchanged. Pending work survives restart and may remain offline indefinitely. A pending deletion hides the entry through the overlay; it needs no placeholder file or deleted Node. Metadata queries describe the visible entry, including pending size and mtime, without reading file contents.

| Event | Accepted file | Pending content | Visible file |
| --- | --- | --- | --- |
| Initially synchronized | A | None | A |
| Local save B | A | B | B |
| Local save C while B is submitted | A | B, C | C |
| Install authority acceptance of B | B | C | C |
| Install authority acceptance of C | C | None | C |

The table shows acceptance without rebasing. The authority may instead accept B as M. Install M from the canonical change feed before retiring B, then preserve C's original B-to-C intent; never relabel C as an M-to-C edit. An acknowledgment alone does not supply the accepted result or retire pending work. Local metadata outside the replicated fields remains local when authority updates arrive.

**Retained versions and conflicts**

Journaled edits preserve affected before-state metadata and content hashes; applying their operations derives the after-state. They do not require full tree snapshots. A synchronized file needs only its accepted bytes; state need not duplicate all clean files. Pending writes initially store complete replacement bytes, not byte-level patches. Before replacing or deleting accepted content, preserve any version still referenced by pending work, recovery, or a current conflict. Retention grows with changed files and required history.

`StoredConflict` stores small frozen maps of `{ node: EntityData, path }` for base/local/remote, with file bytes referenced by hash. Null entries mean absence; a null base means unknown. Capture historical paths directly, without retaining ancestors merely to reconstruct names. The three maps have the same keys, so there is no separate entity-ID list. Edit IDs supply `Conflict.operations`; snapshot hydration does not replay those edits. `Conflict` adds offline `readFile` methods. No separate snapshot files or full baseline copy are required.

Conflicts never block and never wait for a person. The authority's state always installs. When a submission is rejected as a conflict or an invalid tree, or when an incoming change invalidates pending work, the engine captures the affected edits and their dependents as a preserved version, drops them from pending, and installs the authority state, all in one local transition. The view never shows work the authority has refused. Unrelated work and the incoming cursor are unaffected, so there is no suspension, no blocked submission and no comparison refresh: a preserved version is immutable from the moment it is captured. Operational errors never cause a capture; they are retried.

A preserved version is informational. It appears in `issues()` with its base, local and remote snapshots and readable bytes, and stays until dismissed. There is no automatic TTL yet; a local retention period mirroring the authority's purge is a later knob. Restoring needs no engine operation: the host writes the preserved version back through the view, a `writeFile` for a lost content edit, a `rename` for a lost move, as ordinary pending work against current state, which may lose again and produce a new preserved version. `dismiss` releases the snapshot and its retained bytes and is a no-op for unknown IDs. Recovery UI should group preserved versions by the sync pass that produced them, so a device that lost a day of work can restore in bulk.

An error issue is keyed by the operation it blocks: a submission, a content fetch, a reconcile, or the lease. It stays listed while retries keep failing, is replaced under the same ID on a repeat failure, and is removed when the operation succeeds. There is no dismissal for errors, because a dismissed error would reappear on the next pass. Errors the engine cannot fix itself, such as a lost lease, corrupt state, or a tree mismatch, persist until the host corrects the cause and the retried operation succeeds.

**Authority contract**

| Operation | Contract |
| --- | --- |
| Bootstrap | A consistent snapshot of the shared tree, its identity, cursor `S`, and a replica submission generation. |
| Changes | Ordered accepted changes after a cursor, or an explicit bootstrap-required response. |
| Submit | A generation, immutable proposal ID, filesystem operations, and their exact base metadata; returns acceptance or rejection with the cursor at the decision. |
| Purge | Delete detached entities after the retention period, as ordinary deletion changes in the feed. Content for detached entities is retained until then. |
| Content transfer | Upload/download immutable content by hash; verify bytes before accepting references to them. |

Pending edits and submissions share `Operation`: create, update selected fields, or delete. Resolve Volume paths to global IDs when authoring. An edit to `/notes/a.txt`, rename of `/notes` to `/text`, and edit to `/text/a.txt` become three ordered edits: change F's content, change D's name, change F's content again. F retains its parent D and identity; descendant paths need no rewrite. Operations within one `Proposal` describe an atomic change, with each entity appearing at most once. Sequential edits remain ordered journal entries.

`Proposal.base` contains exactly the operated IDs: null for a create, complete before-state `EntityData` for an update or deletion. Base metadata is small; content remains a hash reference. It describes the author's input, not a strict current-revision guard. Carrying it explicitly also covers intermediate local states that the authority never accepted verbatim. No historical-state lookup API or second operation vocabulary is needed. The authority can use retained history and bytes, but must not assume its journal contains every client's intermediate state.

Keep necessary dependencies in the client journal: creation of a referenced entity, or an earlier edit whose result is the next edit's input. A renamed ancestor alone does not make an ID-based content write dependent on that rename. Submit dependent work after prerequisites are installed, retaining the original base. Once a request may have been sent, never change its base, operations, generation, or ID.

**Preparing submissions**

Edits stay separate journal records; these rules apply when a proposal is prepared, and they are permissions, not obligations. An engine that submits one edit per proposal satisfies the contract.

1. Collapse per entity. Consecutive pending edits to one entity become one operation: base from the earliest edit, intended values from the latest per component. Intermediate states carry no information, because bytes are opaque whole replacements and location and mode are whole values. A create followed by updates becomes one create; a create followed by a detach with nothing submitted cancels both locally, and the authority never learns the ID.
2. Bundle create-trees. A connected group of new entities, including collapsed updates on those same entities, may share one proposal. Nothing remote can touch an entity the authority has never seen, so such a group can only fail at its root, where every dependent fails anyway. An edit to a pre-existing entity goes in a proposal of its own and waits for its prerequisites to be installed, so a rejection always concerns one edit or one create-tree and needs no attribution from the authority.
3. Chunk along dependencies. A large group may be split into several proposals, provided every prerequisite is in the same or an earlier proposal. Later chunks wait for installation.
4. Fly independent groups concurrently. Proposals with no dependency between them may be in flight at once; the authority serializes them.
5. Retire together. An accepted proposal retires every edit it covered once canonical effects are installed, not before. A rejection captures every edit it covered and their dependents as one preserved version.

**Filesystem rebasing and revisions**

The authority compares base, intended result, and current state for each semantic component: content, location `(parent, name)`, symlink target, and mode. Mode is one whole value, with no per-bit merge. A partial location update first derives the intended tuple from its base. If current equals base, apply the intended value; if current already equals the intended value, the change is satisfied. Otherwise competing values conflict. Different components can combine. A location update to parent null detaches; detached entities keep their name, are exempt from sibling-name validation, and may be re-attached anywhere except beneath their own subtree. Deletion is a purge: it requires unchanged entity data or an already-absent entity, and an entity without children; updates never resurrect deleted entities. Creates require fresh identities, even when an old path is reused.

| Concurrent intent | Initial policy |
| --- | --- |
| Edit a file; move it or rename its ancestor | Combine by identity. |
| Different content replacements on one file | Conflict. Bytes are opaque in v1. |
| Change content; change mode on the same file | Combine; competing mode values conflict. |
| Different moves/renames of the same entity | Conflict on location. |
| Different entries claim one parent/name | Conflict on the occupied name. |
| Detach a directory; edit or add a descendant | Combine by identity: the work rides into the detached tree and remains recoverable. |
| Move A into B; move B into A | Reject the later proposal if it creates a cycle. |

After rebasing, validate authorization and the complete resulting tree: root, existence, directory parents, unique valid sibling names, no root child named `.sync`, and no cycles. Name replacement must explicitly detach or move the known occupant; a purge must not leave children behind. Validate and commit against the same authority state. A stale proposal is not itself a conflict; incompatible intent is. `invalid-tree` diagnoses an invalid proposal, `missing-content` a missing proposed blob, and `conflict` an intent that cannot safely apply to current state. Operational failures preserve work for repair.

This uses OT's ideas of identity, intent, and rebasing, with one authority ordering accepted results. It does not require a transform for every operation sequence or a decentralized tree CRDT. Future content-specific merging belongs on the authority and need not change `Operation`; automatic byte merging is deferred.

`Revision` is a hash of replicated entity state, not just file bytes or a server counter. For the current schema, hash the UTF-8 `JSON.stringify` encoding of `["neo-fs:entity:1", id, type, parent, name, mode, value]`, where value is the content hash for a file, target for a symlink, or null for a directory. Use SHA-256 lowercase hex. This includes location, identity, and mode, excludes local metadata and the revision itself, and changes encoding version when a shipped schema changes replicated fields. A → B → A has the same revision as A; revisions test state equality, not absence of intervening operations. A directory revision does not cover descendants. The opaque ordered `Cursor` governs catch-up. Neither belongs to Store or Volume.

Canonical state, outcome, and one `ChangeBatch` commit atomically, including an empty batch for an accepted no-op. Clients install those accepted effects, which may differ from the proposal. A rejection durably records its outcome and decision cursor without changing the tree; catch up to that position or later before capturing the preserved version's remote side. Repeated submissions return the original outcome without rerunning rebasing.

**Durability and recovery**

The private [state layout](../packages/neo-fs/sync-state.md) uses immutable journal segments, a periodic checkpoint, shared content files, and unpublished temporary writes. Publish content before its referencing segment through write, flush, rename, and directory flush. Segments can contain several events; ordinary saves never rewrite a growing checkpoint. Store and Volume need no physical append primitive.

The local checkpoint covers recorded events, not synchronized edits. The separate authority cursor advances after accepted effects are installed. Acknowledgment awaiting catch-up remains pending even when covered by the local checkpoint. Compaction retains required records and bytes, publishes a durable checkpoint, then collects covered segments. Recovery replays the uncovered tail without blindly repeating network requests or completed writes.

No transaction spans accepted files and `.sync`. Installation is target-oriented and idempotent: `.sync` records each entity's target revision from the authority and the revision installed in the storage tree, content is fetched per hash into `.sync/content` ahead of time and resumes after interruption, and one reconcile loop makes every differing storage entry match its target, recording progress in batches. Recovery runs the same loop again. Only its completion advances the accepted baseline and authority cursor and retires matching pending work. View access must not expose a partially installed batch; run the local reconcile under the serialization that excludes reads and writes, with every byte already local, never during network waits. The engine may fetch content for later batches concurrently while installing batches in order. Status remains available.

Bootstrap is the same reconcile from an empty installed set, and the uninitialized phase ends when it completes. Initial usability and catch-up latency therefore scale with the size of referenced content, which is the accepted v1 trade-off. Per-file availability, where metadata installs before bytes, is deferred; if added, reads of a file whose bytes are not yet local reject with a dedicated code, and no read ever returns partial or empty bytes in place of content.

Recovery reruns an unfinished reconcile before exposing the Volume, without network access. An interrupted call may have taken effect. Missing/corrupt required state stops sync for recovery; inaccessible storage never means deletion. Durability depends on storage honoring file and directory flushes. An ephemeral backend supports only an ephemeral replica.

**Native filesystem behavior**

Native files are a storage backend under the same accepted-plus-overlay model. Direct disk reads bypass the view and can miss pending changes; direct disk writes violate backing ownership. This is equivalent to bypassing an application's database access layer. Neither behavior changes the core sync contract.

Supporting ordinary editors, Git, or shell tools against a live working directory is a separate integration. Such an integration must expose the view or import external changes through it, and own its identity tracking, scans, races, and any extra copies. Defer this integration; the core engine does not scan backing files for consumer edits.

**Catch-up and retention**

The authority gives exactly four retention guarantees, and the engine relies on nothing else.

1. **Outcomes live with the generation.** While a generation is live, a repeated proposal ID returns its recorded outcome. Once it expires, every proposal under it answers bootstrap-required, even if its outcome was never collected. The authority may expire generations by age, by inactivity, or whenever it compacts; the client never learns the policy.
2. **History may expire at any time.** `changes` may answer bootstrap-required at any cursor. The engine must be able to rebootstrap from any state without losing pending work.
3. **Only current content is retained.** The authority keeps bytes for the current state of every live entity, for detached entities until purge, and for a bootstrap snapshot until that generation expires. It need not keep superseded content. The engine therefore coalesces every batch it has received into one target, the latest state per entity, before fetching, and installs that target as one reconcile; the cursor advances to the last coalesced batch. A null content read for a hash learned from `changes` means the state was superseded in the meantime: fetch newer changes and recompute the target. Only a hash the authority still reports as current may be treated as an error. Rejected proposals' bytes are the client's own.
4. **Purged IDs stay refused.** The authority remembers purged entity IDs for at least as long as any live generation could carry a create for them, and rejects such a create as invalid-tree. This is what keeps a stale replica from resurrecting an entity another user removed and the authority purged.

Bootstrap installs the snapshot at cursor `S`, then consumes changes after `S` without a gap. Preserve pending bases and local work across bootstrap; never silently reinterpret them against the new baseline.

Deletion history belongs to the authority's log. Removal is detachment; deletions come from purges. Pending detachments and incoming deletion records live in private state; the accepted filesystem moves detached entries under `.sync/trash` and removes purged ones. Native storage needs no tombstone files in the user tree. A new entry at a removed path has a new ID.

**Settling after a rebootstrap.** Pending work is never guessed about. For each pending edit, the engine compares the fresh snapshot with the edit per component. If the entity already equals the edit's intended state, the proposal was accepted: retire the edit. If the entity still equals the edit's base, it was never applied: re-propose it under the new generation with the same base and a new proposal ID. Otherwise someone else changed it: capture a preserved version. One narrow exception keeps deleted things deleted: a create that was sent, whose outcome is unknown, and whose entity is absent from the snapshot might have been accepted and then purged, so it becomes a preserved version rather than a re-proposal; a create that was never sent is re-proposed as usual. Updates and moves carry no resurrection risk, because the authority rejects a reference to a purged entity.

Locally, preserved versions have no TTL until a retention knob exists, the journal is bounded by checkpoints, content under `.sync` is collected when nothing retained references it, and trash bytes are droppable at any time.

**Initial scope**

V1 sync covers file bytes, directory structure, symlink targets, and mode (`0o777`, including executable bits). Timestamps remain local; size derives from contents or the backend. A `chmod` through the view records a pending mode update, while `utimes` records local metadata. Symlinks are entries; sync does not traverse their targets. Each shared tree excludes mounts into other trees; hosts compose private Volumes with a path router. Report unsupported names, local name collisions, and unsupported entries without overwriting or deleting them.

Defer lazy loading, cache eviction beyond detached subtrees, trash browsing and restore, byte-level patches, native working-directory integration, symmetric P2P, automatic content merging, hard-link topology, full ACL/xattr fidelity, and a generic object-sync framework. Timestamps are metadata, never conflict clocks. Version the protocol and state format; incompatible clients stop or bootstrap through an explicit upgrade path while preserving pending work.

Before implementation is complete, demonstrate offline save/restart, namespace and metadata operations through the view, edit/move/edit sequences, rebased acceptance with dependent edits, competing moves and cycles, detach/edit and detach/create, purge installation, remote-wins capture and restore through the view, interrupted installation, duplicate submissions, expired history, and exclusion of private state. Exercise combinations against a small reference tree, checking invariants, idempotency, and agreement with the authority after pending work drains.

**Milestone: Complete interface design — complete (2026-10-10)**

Scope: types and behavioral contracts. Runtime implementation is outside this milestone. The handoff in `packages/neo-fs/design-progress.md` records the eleven decisions that closed it.

- [x] Store metadata contract: `update` now supports Volume's `chmod` and `utimes`, with field, failure, precision, and durability rules. Creation uses `FILE_MODE` and `DIR_MODE` from Volume, with no umask at any layer.
- [x] Mode replication: `NodeSpec.mode` uses `0o777` for files and directories, with fixed symlink mode; operations, revisions, and conflict comparisons include it. Native permission handling belongs to the backend.
- [x] Initial bootstrap/import and replica binding: one engine-owned `storage` Volume with private state under the reserved `.sync` root entry; local-only opening with an uninitialized phase until the first `sync()` bootstraps; engine-generated replica identity; `Authority.root` checked against saved state; pre-existing entries left untouched and invisible, with import left to migration tooling.

Exit check, passed: the interfaces, this document, the state document and the walkthrough agree on initialization, failure, retention and vocabulary. Internal journal schemas, retention tuning, and installation algorithms follow during implementation; they must honor those guarantees.

The accepted-baseline and pending-operation model takes inspiration from the [Linear sync-engine study](https://raw.githubusercontent.com/wzhudev/reverse-linear-sync-engine/refs/heads/main/README.md); ordered authority updates and rebasing also appear in [CodeMirror's collaboration design](https://codemirror.net/examples/collab/). [Verified OT for trees](https://pschuprikov.me/www/publications/verif-ot.pdf) establishes that OT applies beyond text. The filesystem policies above are this design's choices, not claims about Linear's server implementation.
