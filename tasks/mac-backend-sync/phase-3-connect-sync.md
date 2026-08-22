# Phase 3: connect sync and refresh the runtime

Status: `done`

Depends on: Phase 2

Size: large

Read [README.md](README.md) and [`docs/app.md`](../../docs/app.md) first. Read the sync setup
in [`apps/frieren/src/fs.ts`](../../apps/frieren/src/fs.ts) before changing Mac.

## Outcome

The Mac main Store syncs with the backend. Private data stays local. Pulled app data updates
the running daemon, open apps, launcher catalog, and native projection.

This phase turns on remote sync. Do not split the remote connection and runtime refresh into
separate phases. File sync without live refresh leaves the Store and running app with
different state.

## Work

### Build the remote Store

Create an `httpStore` for `/store`. Use these default origins:

- Production: `https://mykodama.app`
- Development: `https://staging.mykodama.app`

Allow a Mac-specific environment override for tests and local work. Use the current identity
service. The Store fetch function must call `identity.getToken()` for each request so token
refresh does not require a new Store.

Do not add another backend route or wire format. The worker already accepts the Mac OAuth
access token.

### Keep sync state local

Persist these values outside the replicated main tree:

- Replica ID
- Pull cursor
- Push cursor
- Discard bit
- Authenticated owner ID

Write them atomically. A crash must leave either the old value or the new value. It must not
leave invalid JSON. Deleting `volume-v2` must delete this state too, or the wipe path must
delete it explicitly.

### Compose the synced Volume

Pass the main native Store and remote HTTP Store to `synced()`. Use:

- The replica ID as the native Store version author and the sync replica.
- `localFirst` startup.
- Lazy content.
- Durable pull, push, and discard slots.
- The `/private` binding.

Keep the private Store outside `synced()`. The subscription from Phase 1 should activate the
normal local-write debounce. Remote pulls can stay on the normal timer. A dedicated server
notification socket is outside this story.

Expose the sync status for logging. A network error must not stop reads or local writes.

### Enforce the user boundary

Compare the current authenticated user ID with the saved owner ID before connecting the
remote Store.

If the ID changes, including a change to or from signed-out state:

1. Pause and destroy sync.
2. Close the main and private Stores.
3. Delete `volume-v2` and all sync metadata.
4. Clear `runtime.json`.
5. Terminate the daemon.

The existing launcher discovery path starts a clean daemon. A token refresh with the same
user ID does not run this sequence.

### Refresh live state after pulls

Use `Volume.watch`. Do not add a second event bus.

- Watch each open app state file. On change, call `kernel.reload(appId)` and publish the new
  state to its connected app sockets.
- Watch open app bundle manifests. Reload the affected app host when a pull changes its
  executable bundle.
- Watch `/applications` recursively. Refresh the launcher catalog and reconcile the native
  `.app` projection after an install, update, or removal.
- Coalesce a burst into one refresh for each affected target.
- Stop the watches when the app socket closes or the daemon shuts down.

Follow the equivalent Frieren watchers. A remote pull writes directly to the Store and does
not produce the normal kernel write event.

### Shut down in one order

On normal exit:

1. Stop accepting new work.
2. Try one bounded `flush()`.
3. Destroy sync.
4. Stop runtime watches.
5. Close both Stores.
6. Clear `runtime.json`.
7. Release the daemon lock.

Do not wait forever for the network during shutdown.

## Verification

Use a real temporary `fsStore` and a fake HTTP authority for daemon integration tests.

- Backend content appears after the first pull.
- A Finder edit uploads after the watch debounce.
- A backend edit appears on disk.
- No private row or blob reaches the HTTP Store.
- Restart resumes from the saved cursors.
- Offline local writes upload after the connection returns.
- A token refresh for the same ID keeps the local volume.
- Sign-out wipes the volume before another remote request.
- A different user cannot upload the prior user's rows.
- A remote state edit reloads a running app and updates its socket.
- A remote application change refreshes the catalog and native projection.
- Closing an app or the daemon removes its watches.

Run focused file-system and Mac daemon tests while working. Run the repository checks and a
native Mac build before marking the phase done.

## Exit checks

- Sync works in both directions.
- Local work continues while the backend is unavailable.
- Private and user boundaries hold.
- Running apps do not stay stale after a pull.
- [README.md](README.md) and this file both show `done`.
