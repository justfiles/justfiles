# Sync conflict policy

> Research date: 20 August 2026. This follows the decision in
> [`push-guard.md`](push-guard.md) to delete the push-side preflight reads and
> version guards.

## Question

When a replica edits a file from an old state, should sync overwrite the file at
the authority, reject the push, merge the contents, or keep both versions?

The old push guard did not answer this question. It read the authority's current
version and sent that same version back as a compare-and-set guard. That can catch
a write during one network round trip, but it cannot tell whether the local edit
was based on the authority's current version.

Established systems that detect this conflict keep the expected version from an
earlier read or from the last successful sync. None of the systems below obtains
the expected version by reading it immediately before the write.

## What established systems do

| System | How it knows the base | What happens on concurrent edits | Fit here |
| --- | --- | --- | --- |
| Dropbox Nucleus | Persists Remote, Local, and Synced trees. Dropbox calls each node in the Synced tree a merge base. | Dropbox creates a named conflicted copy and asks the user to compare or merge the files. | Closest match. Stable node ids and host-local synced state fit our design. |
| Syncthing | Tracks local, announced, and chosen global file versions in its index. | Renames one version to `.sync-conflict-<date>-<time>-<device>`. It also keeps a conflict copy when a delete wins over an edit. | Good outcome, but its peer-to-peer version choice is more than our central authority needs. |
| Nextcloud Desktop | Detects that both local and remote changed between sync runs. | Keeps the remote file at the original path, writes the local edit as a conflict file, and alerts the user. The conflict file is local-only by default. | The conflict copy fits. Keeping it on one device does not, because an agent or device may never return. |
| CouchDB | A normal update supplies the previous `_rev`; a stale `_rev` gets `409 Conflict`. Replication can retain both revision branches. | Chooses one revision as the visible winner but keeps losing leaves until the application merges or deletes them. | Sound, but a revision tree is too much machinery for a filesystem that must expose one node at a path. |
| OneDrive API | Accepts `If-Match` with the item's earlier ETag and returns `412` when it is stale. | Upload callers can choose `fail`, `replace`, or `rename` for name conflicts. | Confirms that conflict detection and conflict outcome should be separate choices. |

Sources:

- Dropbox explains the three persisted trees and why the Synced tree is a merge
  base in [Testing sync at Dropbox](https://dropbox.tech/infrastructure/-testing-our-new-sync-engine).
  Its user documentation says simultaneous or offline edits create a second file
  in [What's a conflicted copy?](https://help.dropbox.com/organize/conflicted-copy).
  Dropbox's API also offers an update mode that overwrites only when the caller's
  saved revision matches the server revision in
  [`WriteMode.Update`](https://dropbox.github.io/dropbox-sdk-dotnet/gh-pages/obj/api/Dropbox.Api.Files.WriteMode.Update.html).
- Syncthing documents its index versions and conflict-file naming in
  [Understanding Synchronization](https://docs.syncthing.net/users/syncing.html#conflicting-changes).
- Nextcloud documents its remote-wins plus local-conflict-copy behavior in
  [Conflicts](https://docs.nextcloud.com/server/latest/user_manual/en/desktop/conflicts.html).
- CouchDB documents both stale `_rev` rejection and retained conflict branches in
  [Replication and conflict model](https://docs.couchdb.org/en/stable/replication/conflicts.html).
- Microsoft documents `If-Match`, `412 Precondition Failed`, and the
  `fail | replace | rename` choices in
  [Create an upload session](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0).

## What this says about our guard

A useful guard must name the version the edit was based on. Dropbox's Synced tree,
CouchDB's `_rev`, OneDrive's ETag, and Dropbox's `rev` all do that. Reading the
current version at push time answers a different question: "what is there now?"
It cannot answer "has it changed since I edited it?"

Deleting the old guard is therefore the right immediate change. It removes one
remote read per pushed row and makes the current edit policy honest:
last-writer-wins. Keeping the old guard would retain the same outcome with extra
requests and a false claim of conflict detection.

Last-writer-wins is not a good final policy for user files. An old laptop can come
online days later and silently replace newer work. Dropbox, Syncthing, Nextcloud,
and CouchDB differ in representation, but all preserve both edits when they can
prove the edits are concurrent.

## Recommendation

Use the parts of Dropbox's design that fit here when conflict work becomes a
product priority: a persisted merge base and conflict copies.

1. Persist the last version agreed with each peer, keyed by node id, outside the
   replicated tree. Pull and successful push update it. A local edit does not.
2. Send that saved version as the push guard. Do not read the authority first.
3. On an edit/edit mismatch, keep the authority's file at its current path and
   save the incoming edit as `<name> (conflict <replica>)` with a new node id.
4. Sync the conflict copy through the authority so every replica can see it. Do
   not leave the only copy on the device that happened to detect the conflict.
5. Show unresolved conflicts to the user. Content-aware apps may offer a merge,
   but the filesystem must not guess how to merge arbitrary bytes.

This extends behavior the engine already has. Name conflicts produce conflict
copies, edit/delete recreates the edited file under a new id, and the replica id is
already available for a stable suffix. The new work is the durable per-peer base
and an edit/edit settlement path. It does not need a revision tree, a new `Store`
method, or automatic file merging.

## Decision for now

Ship the guard deletion with explicit last-writer-wins semantics. Treat a base
cache and edit conflict copies as one future feature. Building only the cache would
turn a silent overwrite into a refusal with no useful outcome. Building only the
conflict copy would have no sound way to tell a stale edit from a later edit.
