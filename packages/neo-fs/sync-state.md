# Sync state storage

Private persistence for the [filesystem and sync design](../../tasks/fs-sync-design.md). These are storage responsibilities and field sketches, not an implemented format. Public sync types live in [sync.authority.ts](./sync.authority.ts) and [sync.engine.ts](./sync.engine.ts); journal and checkpoint schemas remain internal.

**Accepted files and pending operations**

| Where in `storage` | Contains |
| --- | --- |
| root | Files and directories from the last installed authority state. |
| `/.sync` | The local journal, recovery checkpoint, pending bytes, and retained versions. |

Consumers use `engine.volume`: accepted state with ordered pending operations and local metadata applied. Reads, listings, paths, links, and metadata all use this view. Local saves persist under `.sync` and leave accepted files unchanged. Work the authority refuses is captured as a preserved version and removed from the view; nothing blocks incoming authority changes.

One active engine owns writes to storage, enforced by the lease at `.sync/lock`. `.sync` is a protocol-reserved root name: the view hides it and the authority refuses it, so neither consumers nor incoming changes can reach it. Direct access to storage bypasses the view; supporting an independently edited working directory is a separate integration.

**Folder layout**

Paths are relative to `/.sync` inside the storage Volume; the accepted tree occupies the rest of storage:

```text
/.sync/
├── lock
├── checkpoint.json
├── journal/
│   └── <first-sequence>-<last-sequence>.json
├── content/
│   └── <sha256>
├── trash/
│   └── <entity-id>/...
└── tmp/
    └── <temporary-id>
```

`lock` holds the current owner's token and lease expiry. It is created exclusively through `Store.create`, renewed by rewriting while the engine is open, removed on close, and taken over after expiry by renaming it under `tmp` before creating fresh; the main design defines the resulting ownership rules.

`trash/<entity-id>` holds a detached subtree as ordinary files and directories until the authority purges it or a restore moves it back. The engine may drop those bytes locally and refetch them on restore; their metadata stays in the checkpoint. Entities already detached at bootstrap get metadata only and no trash entries. Trash entries are renamed from the accepted tree, which is why storage must be one Store.

The journal is logically append-only. Each segment holds an ordered array of one or more events published together. Use immutable segments through ordinary Volume writes, rename, and flush; later events go into new segments. Sequence ranges in filenames are zero-padded and must agree with their contents. Publishing several events together lets related state changes commit as one local transition.

There is no required physical append operation in Store or Volume. A future append optimization would need record framing and recovery from a torn tail; it must preserve the same journal semantics. Checkpointing and collection bound retained history without rewriting a growing JSON file on every save.

**`journal/<first>-<last>.json`: durable events**

Each event has a monotonically increasing local `sequence`, a `type`, and its payload. The sequence is also its stable record reference; compaction never renumbers records. Published segments after the checkpoint form a contiguous sequence without overlaps. This is the replica's order of actions and observations, not the authority's global order.

| Event | Payload |
| --- | --- |
| Edit | `Operation[]`, `before: StoredEntries` for affected entities, and `dependsOn: number[]` of earlier edit IDs. |
| Submission | The edit record and the exact `Proposal` prepared for transmission. |
| Outcome | Submission record reference and the returned `Outcome`. |
| Target | An incoming batch or bootstrap: target entity revisions and content references, accepted before-state, and the preserved versions it displaces. |
| Installed | Entities whose storage entries now match their targets, recorded in batches. Completing a target also records new backend ID bindings, advances the authority cursor, and retires matching edits. |
| Preserved/dismissed | `StoredConflict` with the edits it captures and drops, or a dismissal releasing it. |
| Local metadata/issue | Local metadata changes or changes to actionable diagnostics. |

These are payload sketches; exact event tags and installation steps remain to be defined. Persist bigint metadata, including nanosecond timestamps, as decimal strings.

An edit's ID is its journal sequence. Its before-state is the visible state immediately before that edit, with captured paths and content hashes; it may include earlier local changes. Null means an entity is absent before creation. Record the same entity IDs as the operations, without capturing the whole tree or ancestors solely for display paths. Operations within an edit describe one atomic change, with each entity appearing at most once. Sequential updates to the same entity belong in separate edits; submission preparation may collapse them, as the main design describes.

Dependencies preserve causal order: writing a new file depends on its creation; a write based on B depends on the edit producing B; moving into a new directory depends on its creation. A renamed ancestor alone does not make a content write dependent on that rename once the file's ID is captured. A rejected edit and its dependents leave pending together as a preserved version. Derive the pending list from edits and later lifecycle events; accepted edits awaiting installation still count. Lifecycle changes append events without rewriting edits. Local-only metadata does not count as pending.

**One operation vocabulary**

Pending edits and submissions share `Operation`: create, update selected fields, or delete. Resolve paths to entity IDs while authoring. Editing file F, renaming its parent D, and editing F again requires no path rewriting in the operations. A content update supplies only a hash; a directory move leaves its descendants' identities and parent references intact.

Mode (`0..0o777`) is replicated through `EntityData` and pending `update` operations. A `chmod` through the view creates an edit; it is not a local metadata override. Entity revisions and conflict snapshots include mode, compared as one whole value. Symlink mode is fixed at `0o777`; `chmod` follows the link. Timestamps remain local metadata.

`Proposal` adds a submission ID, generation, and `base: Record<EntityId, EntityData | null>`. Derive base from the edit's before-state, omitting display paths. It contains exactly the operated IDs, null for creates and complete data for updates/deletions. These are merge inputs, not strict equality guards against the whole current entity. Accepted `Change` records remain distinct: canonical full entity states with deterministic state-hash revisions, or explicit deletions. The [main design](../../tasks/fs-sync-design.md) defines revision encoding and filesystem rebasing rules.

The client submits original intent for the authority to rebase, waiting for prerequisites to be installed unless the preparation rules in the main design allow bundling them. The submission record names every edit the proposal covers. The overlay derives each touched component from the edit's base, including both parent and name for a location change, and leaves untouched components alone. It never relabels edits with a newer base. Exact metadata supports local states absent from authority history without another lookup endpoint or mandatory base file copy.

| Step | Accepted bytes | Pending work |
| --- | --- | --- |
| Save B, then save C | A | Edit 1: A → B; edit 2: B → C, dependent on 1. |
| Authority accepts edit 1 as M | A | Record the acknowledgment; keep both edits. |
| Install canonical M | M | Retire edit 1; edit 2 still describes B → C. |
| Submit edit 2 | M | Send base B and intended C; authority compares them with M. |

File replacements remain opaque in v1: distinct competing hashes conflict. The same flow handles structural rebasing that combines local changes with authority changes to other components. Hash equality is state equality, not proof that nothing happened in between.

Persist the exact submission before sending it. Retries reuse its ID, generation, operations, and base unchanged. Corrections use a new submission ID. An absent outcome means unknown, not rejected. A recorded acceptance retires its edit only after canonical effects are durably installed. Accepted no-ops also have a change batch, possibly empty. A rejection carries the authority cursor at its decision; catch up to that position or later before capturing the preserved version's remote side. If that history expired, bootstrap while preserving pending work.

**`checkpoint.json`: saved engine state**

A checkpoint periodically captures accumulated engine state through a complete journal segment. It is not rewritten for each event and contains no duplicate tree of file bytes.

| Field | Data |
| --- | --- |
| `formatVersion` | Private persistence format version. |
| `replicaId` | Stable replica identity, generated by the engine on first open. |
| `through` | Last local journal sequence included in this checkpoint. |
| `accepted` | Authority root, generation, installed authority cursor, and current entity metadata/revisions/hashes; absent until initialized. Opening rejects when the saved root differs from `Authority.root`. |
| `nodes` | Global entity ID to stable view Node ID and optional accepted-backend Node ID, including detached entities. |
| `localMetadata` | Local timestamp overrides by entity ID; never replicated mode. |
| `pending` | Ordered array of unretired edit record references. |
| `records` | Retained journal records required by pending work, submissions, conflict operation lists, or recovery, keyed by their original sequences. |
| `conflicts` | Current conflict record references. |
| `reconcile` | Entities whose storage entry does not yet match `accepted`, with the revision currently installed; empty when installed. |
| `errors` | Current actionable diagnostics as plain IDs, messages, and optional codes. |

The fields describe a recovery snapshot, not a second mutable source of truth. Replay updates this state in memory. Retained records serve as lookup data; they are not replayed as new events. Saving a checkpoint can include old pending edits: `through = 103` does not mean edits through 103 have synchronized.

| Position | Meaning |
| --- | --- |
| `through` | Local journal events included in the saved engine state. |
| `accepted.cursor` | Authority changes durably installed in the accepted tree. |

For example, events 101 and 102 can record two edits, and 103 a rejection of the first. A checkpoint through 103 still contains both edits in pending. Their status is determined by their recorded lifecycle, not by comparing their sequence with a cursor.

**Conflicts store frozen metadata and shared content references**

`StoredConflict` is private serializable data embedded in a journal event:

| Field | Data |
| --- | --- |
| `id` | Identity of this preserved version. |
| `message` | The conflict's explanation. |
| `editIds` | Local edits captured and dropped by this version. |
| `base`, `local`, `remote` | `StoredEntries`: maps from entity ID to `{ path, node: EntityData }` or null. The entire base map can be null when unknown. |

Every known side has exactly the same keys; no separate `entityIds` list is needed. A null entry means absent on that side. A null base means unknown, distinct from a known base with absent entries. Include structurally involved entries when they matter to the comparison, not every ancestor. Each present node's ID matches its key. Paths are captured absolute paths, so later moves do not change their historical meaning. Revisions need not be duplicated alongside the entity data from which they are derived.

These maps freeze small metadata, not file bytes. Each file node's content hash points to shared immutable bytes. They do not track live accepted files or need to stay in sync with them. Base can describe earlier pending work, not necessarily an authority-accepted state. There are no mandatory base/local/remote snapshot files or journal before/after pointers to interpret.

`engine.conflict(id)` copies the maps into sides, derives `operations` from `editIds`, and attaches offline `readFile` methods that resolve their hashes. Retain those edits for operation display; they are unnecessary for reconstructing snapshot metadata or paths. Reads never silently fall back to the authority.

Capture happens in one segment: the preserved version, the edits it drops, and the target that installs the authority state. Later authority updates keep advancing accepted state and never change a preserved version; it is immutable from capture and remains available even if its original parent or file is later detached or purged remotely. Dismissal appends a release in its own segment, after which the version's retained bytes become collectable. Operational errors never trigger a capture.

**`content/<sha256>`: immutable file bytes**

Each file holds raw bytes matching its SHA-256 name. This stores pending replacements, incoming bytes awaiting installation, and historical versions still needed by pending work, conflicts, or recovery. Identical content shares one file. Pending writes initially store complete replacement files; byte-level patches are deferred.

Clean file bytes normally live only in accepted. A hash reference can resolve there while the current accepted metadata identifies the same content; verify the hash rather than trusting a historical path. Before replacing or deleting accepted bytes, preserve any version still referenced by retained state. A preserved version's remote bytes are installed in accepted at capture and retained under the general rule once accepted moves on. Missing or corrupt required bytes are an error, never an implicit network read or an empty file.

For accepted A and pending B, incoming R requires retaining A while B's base references it. A rejection captures A/B/R and removes B from the view. If the authority later sends S, install S and advance the cursor; the preserved version still reads A/B/R, so R is retained until the version is dismissed. Extra storage follows changed files and retained history, rather than automatically doubling the whole tree.

**Publication, recovery, and collection**

Temporary files are unpublished. To publish content or a segment, write under `tmp`, flush the file, rename to its final path, and flush the affected directories. Publish required content before its referencing segment. A local save returns only after that segment is durable. Final journal filenames identify published segments; temporary files do not. A corrupt final segment or a gap is a recovery error. If a publication outcome is uncertain, recover it before assigning further sequences.

There is no transaction across accepted files and `.sync`. Installation is target-oriented and idempotent rather than a recoverable plan:

1. Coalesce every received batch into one target, the latest state per entity, then fetch each content hash it references into `content`, one file at a time, each durable on its own. A null read for a hash learned from `changes` means the state was superseded: fetch newer changes and recompute the target. This runs outside any serialization and resumes after interruption from whatever is already present. Persist old versions that must survive, required conflict captures, and the target event; capture any preserved version before overwriting its readable local state.
2. Reconcile under the serialization that excludes view reads and writes, never during network waits: for every entity whose installed revision differs from its target, make the storage entry match, flush, and record progress in batches. Every step is idempotent, so recovery redoes at most the unrecorded tail. A name swap moves the occupant to a temporary name under `.sync` first; content replacement publishes through `tmp` and rename.
3. When no entity differs, record installation: advance the authority cursor, retire matching accepted edits, publish the updated view/conflict state, and wake `remote` watchers for the entries whose visible state changed. Preserved versions never delay this step. An acknowledgment alone cannot do it.

Bootstrap is the same reconcile from an empty installed set, and the uninitialized phase ends when it completes. The engine may fetch content for later batches concurrently while installing batches in order, so a catch-up stall is bounded by bandwidth rather than sequential transfers. Initial usability and catch-up latency scale with referenced content size; that is the accepted v1 trade-off. Per-file availability, where metadata installs before bytes, is deferred: if added, reads of a file whose bytes are not yet local reject with a dedicated code, and no read ever returns partial or empty bytes in place of content.

On load, read the checkpoint, replay subsequent segments to reconstruct engine state, then rerun any unfinished reconcile before returning `engine.volume`. Replay itself does not resend requests or blindly repeat completed filesystem writes. Later `sync()` calls resume outstanding exchanges using persisted request identities. Startup recovery needs no network. Storage without `.sync` has no checkpoint: the engine writes the layout and replica identity, leaves any existing entries untouched, and the replica stays uninitialized until the first sync pass bootstraps. Reconcile touches only entries bound to known entities; a name occupied by an unowned entry is an error issue.

To compact, capture a consistent state at a segment boundary, including all still-required old records and their transitive references. Atomically replace and flush the checkpoint. Only then delete covered segments. A crash can leave both the checkpoint and covered segments; recovery ignores the covered prefix. No older checkpoint is needed to interpret the retained records.

Collect content only when the durable checkpoint, the uncovered journal tail, pending work, current conflicts, and unfinished reconciles no longer reference it. The local journal is bounded recovery history, not a permanent mirror of the authority's log. Durability depends on the storage Volume's file and directory flush guarantees.

Exact event and installation schemas and authority retention limits remain to be specified; startup, binding, import, and detachment rules live in the main design. Authority history retains deletion records; local pending deletes and incoming deletions are journal data. Neither requires tombstone files in the accepted tree or physical append support from its backend.
