# Phase 1: make `fsStore` sync-ready

Status: `todo`

Depends on: none

Size: medium

Read [README.md](README.md) first.

## Outcome

`fsStore` can author changes for a sync replica and can notify a consumer after it records a
native file change. Current callers keep their existing behavior.

Mac remains local-only after this phase.

## Work

### Give native observations the replica author

`fsStore` currently creates one private `fs:<uuid>` author. Changes made through a synced
Volume use the sync replica author, but changes found in Finder or another process use the
private author. The engine will not push those rows.

Add one optional version source to `FsStoreOptions`. Use it for every row minted by disk
reconciliation. Keep the current private author as the default. Do not make `fsStore` import
the sync wrapper.

The same replica can have more than one version counter because each version also has a
nonce. Reuse the existing version helper if it fits without adding another public type.

### Add a real Store subscription

`fsStore` already watches the native tree and records dirty paths. It now drains those paths
only when `since()` runs. Add `subscribe()` so an OS event schedules reconciliation and then
delivers the rows that reconciliation added to the Store feed.

The order matters. A listener must not run before the new rows are available through
`since()`.

The OS watcher is a hint. It can combine events or lose them. Keep the existing full-scan
fallback, and make sure the subscription path also reaches that fallback. One slow scan must
not start another scan in parallel.

Internal `commit()` calls must notify subscribers after the sidecar save succeeds. A failed
commit must not notify them. `close()` must stop the native watcher, scan timer, and pending
delivery.

Do not change the `Store.subscribe()` contract. It delivers Store rows, not raw native watch
events.

### Move host-only state to `/private`

Move these paths:

- `/.state/clientid` to `/private/state/clientid`
- `/.state/installing` to `/private/state/installing`

Update the comments that still describe `/.state` as local-only. Do not add migration code.
The app has no shipped data.

## Verification

Add tests with a real temporary directory and the existing fake disk where useful.

- A Finder-style create, edit, rename, and delete uses the supplied replica author.
- An external change calls the subscriber after `since()` can read its row.
- An internal commit calls the subscriber after the commit completes.
- A failed commit does not call the subscriber.
- Combined native events still produce the correct rows.
- The full scan finds a change when the native watcher drops an event.
- Unsubscribe and `close()` stop later callbacks.
- The default author still works when the new option is absent.
- Device ID and install marker tests use the new `/private` paths.

Run the focused `packages/fs` tests while working. Run the repository checks before marking
the phase done.

## Exit checks

- Existing Store conformance tests pass.
- Existing Volume watch tests pass.
- Existing sync tests pass.
- Mac and Frieren compile with the new private paths.
- [README.md](README.md) and this file both show `done`.
