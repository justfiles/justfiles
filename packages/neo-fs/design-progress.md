# neo-fs design progress

Updated: 2026-10-10.

This is a handoff for the design discussion. It distinguishes agreed contracts from proposals; the linked design documents contain the detail.

## Current milestone

**Complete interface design — complete.** Runtime implementation and migration from `packages/fs` remain out of scope and are the next milestones.

Eleven focused decisions are settled:

- Metadata updates: add `Store.update(id, { mode?, mtimeNs? })`, separate from content writes.
- Permission replication: use ordinary `0o777` mode throughout the filesystem and sync model.
- Startup, import and binding: one engine-owned `storage` Volume with private state under the reserved `.sync` root entry, local-only opening, bootstrap inside `sync()`, and `Authority.root` binding.
- Change notification: one wake-style `Volume.watch` with a `local`/`remote` source.
- Creation defaults: Volume creates with `FILE_MODE` (`0o644`) and `DIR_MODE` (`0o755`), overwrites keep mode, and no layer applies a umask.
- Single ownership: a lease in `.sync/lock` enforced by the engine, with `LOCKED` on `ReplicaError`.
- Retention: four authority guarantees (outcomes live with the generation, history may expire, only current content is kept, purged IDs stay refused); the engine coalesces batches into one target and settles old pending work after a rebootstrap by comparison, never by replay.
- Composition: no mount points; private subtrees are host-composed Volumes via a path router, and the engine ignores storage entries it does not own.
- Conflicts and errors: remote always wins, local versions are preserved and informational, errors self-clear. `resolve`, `ConflictChoice`, `ConflictResolutionError`, `Conflict.choices` and the `conflicts` option are removed; `dismiss` is added.
- Installation and content availability: idempotent reconcile from per-entity target and installed revisions in `.sync`, resumable per-hash fetch, fetch before install, bootstrap as one reconcile, per-file availability deferred with its shape fixed.
- Removal: `rm` gains `recursive`; through the view it detaches the entity in one O(1) update, and purging is the authority's retention policy.
- Submission preparation: per-entity collapse and create-tree bundling remove serial round trips for offline bursts without any type change.

The final reconciliation pass found and fixed rename slips (local checkpoint wording that had become cursor, filesystem writes that had become proposals) and stale conflict wording in the state document and walkthrough. The four artifacts now agree.

## What exists

The new `@justfiles/neo-fs` package sits alongside the existing filesystem package. It is an interface skeleton, not a working filesystem: `volume()` still throws its TODO error, `synced()` is a declaration, and `index.ts` exports nothing.

| Artifact | Current role |
| --- | --- |
| [node.ts](./node.ts) | Local `NodeId`, shared `NodeSpec`, and filesystem `Node` metadata. |
| [store.ts](./store.ts) | Backend primitives over local IDs, including metadata updates and flush guarantees. |
| [volume.ts](./volume.ts) | Path-based filesystem interface, links, metadata operations, flushing and wake-style change notification. |
| [error.ts](./error.ts) | Filesystem errors using familiar native string codes and optional paths. |
| [sync.authority.ts](./sync.authority.ts) | Tree root, bootstrap, ordered changes, content transfer, submission, the reserved `.sync` name and shared protocol types. |
| [sync.engine.ts](./sync.engine.ts) | Opening contract, view, status, issues, preserved-version inspection and dismissal, sync and close; private stored conflict shape. |
| [Main design](../../tasks/fs-sync-design.md) | Responsibilities and behavioral contracts. |
| [State storage design](./sync-state.md) | Journal, checkpoint, content retention and recovery responsibilities. |
| [Visual walkthrough](./sync-walkthrough.html) | Nine SVG diagrams and an interactive save timeline, including the startup contract. |
| [Permission research](./mode-sync-research.md) | Prior-art notes; the design documents record the adopted policy. |

## Agreed decisions

### Filesystem and sync remain separate

- Keep `Volume` over `Store`. A backend implements ordinary filesystem primitives; it does not implement sync-specific shortcuts.
- Local node IDs are distinct from globally unique replicated entity IDs. The engine owns their mapping. Moves preserve entity identity; a new entry at a deleted path gets a new identity.
- Sync uses a dedicated, filesystem-aware authority. It is not symmetric synchronization between two Volumes or a completely domain-agnostic object engine.
- The same client engine persists through ordinary Volumes across runtimes, without direct access to a backend database.

### Accepted state plus pending intent

- Consumers use `engine.volume`: accepted state with ordered pending intent and local metadata applied consistently to reads, paths, listings, links and writes.
- Local saves persist pending bytes and journal events before returning. They leave accepted files unchanged.
- Accepted changes only when canonical authority effects are installed. A submission acknowledgment alone does not retire pending work.
- One active engine owns the single `storage` Volume: the accepted tree at its root, private state under `.sync`. The engine enforces this with a lease at `.sync/lock`, acquired through `Store.create`'s exclusive semantics, renewed while open, released on close, and taken over after expiry by atomic rename. A second opener rejects with `LOCKED`; a lost lease stops writes and surfaces as a `LOCKED` issue.
- Native programs that bypass the engine see accepted files and the hidden `.sync` directory, not the overlay. Supporting an independently edited native working directory is a separate integration.
- `Volume.watch` is one wake-style primitive with a `local`/`remote` source and no per-change detail. It lives in whichever Volume performs the writes: `volume(store)` wakes after its own calls, and the view wakes `remote` after an installation completes, including the removal of refused local work. Store is unchanged; wrappers and proxies forward.

### Startup, binding and import

- `synced({ storage, authority })` never uses the network. Storage without `.sync` gets the private layout and an engine-generated replica identity and opens uninitialized, leaving existing entries untouched and invisible; managed storage replays and recovers.
- The engine never touches storage entries it does not own; its view is the entity map, not a directory scan. Stray files and a host's private directory inside storage are never synced or removed; an incoming name they occupy is an error issue. `UNMANAGED_STORAGE` was removed, since a native folder is nonempty as soon as Finder opens it.
- The shared tree has no mount points. Hosts compose private Volumes with a path router that forwards every method and `watch`, shadows mounted prefixes, and rejects cross-boundary renames with `EXDEV`. The router is host code.
- Until the first bootstrap completes, `status().phase` is `uninitialized` and every `engine.volume` call rejects with `UNINITIALIZED`. `sync()` bootstraps when no authority cursor is installed or the authority requires it, resuming an interrupted bootstrap. There is one bootstrap path.
- `.sync` is reserved by the protocol. The view hides it, with `ENOENT` for reads under it and `EPERM` for creating, renaming into or removing it. The authority rejects a root child with that name as `invalid-tree`.
- `Authority.root` is known without a network call and equals the bootstrap root. Saved state records root and replica identity; opening rejects a different root with `TREE_MISMATCH`, offline included.
- Import is not an engine concern. Pre-existing files have no shared identity; a migration tool copies them through `engine.volume` after bootstrap, producing ordinary pending edits.

### Metadata and permissions

- `Node` reports `mtimeNs` and `size`; metadata queries do not require reading file bytes.
- `Store.write` changes bytes and automatic size/mtime. `Store.update` changes mode and/or mtime; omitted fields stay unchanged. Updates do not flush or promise atomicity across fields.
- `Store.create` receives mode explicitly and never defaults it. Volume supplies `FILE_MODE` and `DIR_MODE`; `writeFile` over an existing file keeps its mode. Optional `mode` parameters were deferred: a create followed by `chmod` collapses into one create operation, so they would only save a call.
- `NodeSpec.mode` carries ordinary owner/group/other rwx bits, an integer from zero through `0o777`. `Node` and replicated `EntityData` inherit it. Symlinks have fixed mode `0o777`; `chmod` follows links.
- Mode participates in operations, revisions and conflicts as one whole value. Special bits, ownership and host permission enforcement are outside the model; native mapping belongs to the backend.
- Timestamps remain local and never serve as conflict clocks. Size derives from contents or the backend.

### Shared operation vocabulary and authority decisions

- Pending edits and submissions use the same `Operation`: create, partial update or delete, addressed by entity ID. Canonical incoming `Change` records remain distinct: full accepted entities or explicit deletions.
- A `Proposal` carries an immutable ID, generation, operations and exact `base` metadata for the operated entities. Base can describe earlier local work never accepted verbatim.
- Each entity appears at most once per proposal. Sequential edits remain separate journal records, with necessary dependencies. Submit dependent work after prerequisites are installed, retaining its original base.
- Submission preparation may collapse consecutive edits to one entity into one operation with the earliest base, bundle a connected group of new entities into one proposal, chunk along dependencies, and fly independent proposals concurrently. Edits to pre-existing entities submit alone, so a rejection never needs attribution. A create followed by a detach with nothing submitted cancels locally.
- The authority compares content, location `(parent, name)`, symlink target and mode separately. Apply when current equals base; no-op when current already equals intended; otherwise competing values conflict. Validate the complete resulting tree before committing.
- Removal is detachment: a location update to parent null, for files and directories alike, with the subtree untouched and never enumerated. Detached entities keep their name, have no siblings, may be re-attached, and live locally under `.sync/trash/<entityId>`. Concurrent work beneath rides along and stays recoverable. `delete` describes purges, which the authority issues after its retention period as ordinary changes. Trash browsing and restore are deferred.
- Storage is one Store, because detachment and journal publication are renames into `.sync`. Bootstrap and the feed carry detached entities as metadata; their bytes are fetched only when a restore re-attaches them, and the engine may drop trash bytes at any time.
- File bytes are opaque whole-file replacements in v1. Filesystem rebasing borrows OT's identity and intent principles without implementing text OT or a transform for every operation pair.
- Canonical state, outcome and one change batch commit atomically, including an empty batch for an accepted no-op. Rejections record the decision cursor.
- Exact `(generation, proposal ID)` retries return the original outcome. Changing the payload under that identity is an error. Expired generations require bootstrap; ambiguous old submissions must not be blindly replayed.

### Three different kinds of version

| Value | Meaning |
| --- | --- |
| Content `Hash` | SHA-256 of file bytes. |
| Entity `Revision` | SHA-256 of canonical replicated entity state, including identity, location and mode. Equal states have equal revisions; directory revisions do not cover descendants. |
| Authority `Cursor` | Opaque ordered history position used for catch-up. |

The local journal sequence is a fourth, independent position: it orders local events and identifies edits. The recovery checkpoint's `through` field does not indicate which edits have synchronized.

### Conflicts never block: remote wins, local versions are preserved

- Authority state always installs. A rejected or invalidated edit and its dependents are captured as a preserved version, dropped from pending, and removed from the view in one local transition. No suspension, blocked submissions, comparison refreshes or choices exist.
- Private `StoredConflict` is serializable: ID, message, edit references and frozen base/local/remote maps of captured paths plus `EntityData`. Bytes remain shared hash references.
- Public `Conflict` hydrates those maps with operations and offline snapshot `readFile` methods. A preserved version is immutable from capture and informational. `dismiss(id)` releases it and is a no-op for unknown IDs. No automatic TTL yet; a local retention period is a later knob.
- Restore needs no engine API: the host writes the preserved version back through the view as ordinary pending work. Recovery UI should group versions by the sync pass that produced them.
- Errors self-clear: keyed by the operation they block, replaced under the same ID on repeat failure, removed on success. No dismissal for errors. Operational errors never cause a capture.

### Persistence and recovery

- State uses immutable journal segments, periodic `checkpoint.json`, shared `content/<hash>` files and unpublished `tmp` files. The journal is logically append-only; Store and Volume need no physical append primitive.
- Pending edits retain affected before-state and dependencies. Lifecycle changes append events rather than rewriting edits.
- Clean accepted bytes need no permanent second copy. Preserve old bytes before replacement only while pending work, conflicts or recovery still reference them.
- Installation is an idempotent reconcile: `.sync` records each entity's target and installed revision, content is fetched per hash and resumes after interruption, and the loop makes differing storage entries match, recording progress in batches. Only its completion advances the installed authority cursor and retires matching edits. Bootstrap is the same reconcile from an empty set; the engine may prefetch later batches' content while installing in order. Per-file availability is deferred; if added, it is a dedicated read rejection, never partial bytes.
- Serialize view access during the local reconcile, with every byte already local and never during network waits. Rerun an unfinished reconcile before exposing an initialized Volume.
- Compaction retains required records and bytes before collecting covered history. Deletions live in authority history and local journal records, not tombstone Nodes or native placeholder files.

## Discussion record

The four open questions (behavior before the first bootstrap, meaning of existing local files, pairing of accepted and state, and binding the authority tree to saved state) were settled as recorded above. The types now carry `storage`, `Authority.root`, `STATE_DIR`, the `uninitialized` phase and `ReplicaError`, whose `LOCKED` code covers the storage lease. `UNMANAGED_STORAGE` was later removed in favor of ignoring unowned entries.

Removal was settled next. Deleting a subtree as one edit with N delete operations was rejected: it makes the proposal, the journal record and any conflict snapshot O(N), and parent deletes would wait on child deletes for serial round trips. A replicated trash folder was refined into detachment, which needs no reserved shared name and cannot collide. The policy shift is explicit: concurrent work beneath a removed directory is preserved in the trash rather than rejecting the removal.

The main design now explains why the old package is replaced: a symmetric table sync with push-time guards, tombstone rows, mount rows and host-held bookkeeping has no durable base for an edit, so it cannot preserve a losing edit, explain a rejection, or stay usable with unsettled history.

Retention was pinned to four authority guarantees. The one judgment call: a create that was sent with an unknown outcome and whose entity is absent after a rebootstrap becomes a preserved version instead of being re-proposed, because it may have been accepted and then purged, and resurrecting what another user removed is the wrong kind of automatic. The authority also remembers purged IDs for the life of any generation that could reference them, so the same protection holds for proposals that arrive late under a live generation.

Vocabulary was revised for readers rather than implementers: `Checkpoint` became `Cursor` (it collided with the local `checkpoint.json`), `Epoch` became `Generation`, `Mutation` became `Proposal`, the result type `Submission` became `Outcome`, `ConflictView`/`ConflictSnapshot` became `Conflict`/`ConflictSide`, and the prose uses view, installed and visible in place of projection, incorporated and materialized. The main design now opens with a glossary.

Conflict handling was made hands-free. The product promise is that the tree converges without attention, so the authority always wins and the losing local version is preserved with its bytes for optional recovery through dedicated UI. No conflict outcome is unrecoverable, so none needs manual resolution, and the resolution surface collapsed to inspect and dismiss. This removed visible conflicting overlays, suspension, blocked dependents and comparison refreshes, the most complex paths in the engine. Two consequences are recorded: the winner is whoever synced first, not whoever edited last, so bulk restore matters; and apps that keep state in files must treat their own save as provisional and re-read on a remote wake.

Installation was simplified from a recoverable step plan to a target-oriented reconcile: `.sync` is the record of target and installed state, every step is idempotent, and recovery is rerunning the loop. Incremental installation does not change visibility: a batch still appears atomically because the reconcile runs under the read serialization with all bytes prefetched. Making a fresh replica usable before every byte is local was deferred, since that adds a per-file availability state every consumer must handle.

Submission preparation followed. Adding the offending entity IDs to a rejection was considered so that a bundled proposal could fail partially; it was dropped because partial failure only arises when new and pre-existing entities share a proposal, and keeping edits to pre-existing entities in their own proposals removes the case at the cost of one round trip.

Two startup alternatives were considered and dropped:

- **Sibling subtrees** (`/accepted` and `/state` inside storage) need no filtering, but make every raw storage Volume look like an implementation detail. Portability won: a storage Volume handed to read-only code shows content plus one hidden folder, as a checkout shows `.git`. The cost is one reserved name at one level, enforced in the view and at the authority.
- **Bootstrapping inside `synced()`** would hide a network dependency in opening and add a second bootstrap path. The engine must already bootstrap inside a sync pass because `changes()` can answer bootstrap-required, so a fresh replica reuses that path and the gap is reported as a phase instead of hidden.

## What to do next

1. Implement `volume(store)` with a memory Store and a conformance suite, including `watch`, recursive `rm`, creation defaults and the FsError contract.
2. Implement the engine against a memory authority: journal, checkpoint, reconcile, lease, detachment, preserved versions, submission preparation and the rebootstrap settling rules, exercising the demonstration list in the main design.
3. Design migration from `packages/fs`, including the import tool that copies existing files through the view.

Exact journal schemas, installation algorithms, compaction tuning, backends and runtime tests belong to implementation after this milestone. Lazy loading/eviction, automatic text merging, byte patches, native external-writer integration, symmetric P2P, hard links and full ACL/xattr fidelity remain deferred.

## Verification so far

Previous scoped checks passed package typechecking and the changed interface checks, with an existing unused-parameter warning in the unimplemented `volume()` stub. The walkthrough passed Biome and browser checks for desktop/mobile layout, all six timeline states and source links. These verify the declarations and explanatory artifact, not runtime filesystem or sync behavior.

The milestone closed with declarations and documentation only; no runtime code exists yet.
