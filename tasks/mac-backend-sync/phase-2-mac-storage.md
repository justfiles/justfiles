# Phase 2: make Mac storage safe

Status: `todo`

Depends on: Phase 1

Size: medium

Read [README.md](README.md) and [`docs/app.md`](../../docs/app.md) first.

## Outcome

Mac runs on a new main Store with a local `/private` mount. One daemon owns both Stores and
closes them in one place. A second daemon cannot open the volume.

Mac remains local-only after this phase.

## Work

### Stop a second daemon

Add a daemon-owned exclusive lock under the Kodama support directory. Acquire it before the
daemon opens either Store or writes `runtime.json`. Hold it for the full process lifetime.

The launcher discovery check is not a lock. Two launchers can both pass it before either
daemon writes `runtime.json`. They may both spawn, but only the process that gets the lock
can continue. The other process exits without opening the volume.

The lock must recover after a crash. Test the real mechanism instead of relying only on a PID
file test.

### Split main and private storage

Use a new versioned volume path so old developer data cannot affect the new layout. Keep the
two physical roots as siblings:

```text
volume-v2/main
volume-v2/private
```

Create one `fsStore` for each root. Exclude the root name `private` from the main native
Store and announce the `/private` mount. Bind the private Store when constructing the
Volume.

Do not place the private Store inside the main physical root. The main OS watcher must not
see private changes.

### Give storage one owner

Replace the bare memoized Volume with one small owner object. It holds:

- The mounted Volume used by existing Mac services.
- The main Store.
- The private Store.
- An idempotent `close()` method.

Keep `getVolume()` simple for existing consumers. Do not expose the two Stores outside the
module unless Phase 3 cannot compose sync without it.

Close both Stores before releasing the daemon lock. Clear `runtime.json` during normal
shutdown.

## Verification

- Start two daemon processes at the same time. One continues and one exits.
- Kill the winning daemon without cleanup. A new daemon can acquire the lock.
- A normal file appears only below `volume-v2/main`.
- A `/private` file appears only below `volume-v2/private`.
- Main `since()` never returns a child of the private mount.
- Accounts, caches, device ID, install markers, and active AI state use the private Store.
- The kernel, app installation, launcher catalog, and native app projection still work.
- Shutdown closes both native watchers and removes stale runtime discovery data.

Run focused daemon and file-system tests while working. Run the repository checks before
marking the phase done.

## Exit checks

- The Mac app works with no backend connection.
- One process owns the whole native volume.
- Private content cannot enter the main feed.
- No migration code exists for the old volume.
- [README.md](README.md) and this file both show `done`.
