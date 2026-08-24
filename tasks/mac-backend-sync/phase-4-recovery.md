# Phase 4: test failure and recovery

Status: `done`

Depends on: Phase 3

Size: small to medium

Read [README.md](README.md) first.

## Outcome

Automated tests prove that process races, network faults, token faults, and interrupted sync
do not cross the private or user boundaries. Fix only faults that these tests find. Do not
add another recovery system beside the Store and sync engine.

## Work

Add integration coverage for these cases:

- Two launchers start at the same time.
- The daemon crashes during a local Store write.
- The daemon crashes during push.
- The daemon crashes during pull.
- The access token expires and refresh succeeds.
- The network stops during a blob transfer.
- The daemon restarts with saved cursors.
- The native watcher combines or loses events.
- Sign-out occurs while sync is active.
- The user ID changes while apps have open sockets.
- The backend removes an app while its native projection exists.
- Every Volume write method keeps `/private` out of the remote Store.
- Concurrent file edits follow the current last-writer policy.
- Concurrent creates keep both conflict copies.

Use deterministic fake failures. Do not use time delays when a controllable promise or fake
clock can prove the same behavior.

## Verification

- Run the focused failure tests more than once to find leaked timers, watchers, ports, and
  file handles.
- Run all `packages/fs` tests.
- Run all Mac daemon tests.
- Run the full repository format, type-check, lint, and test commands.
- Build the native Mac app.
- Review logs from one offline start. Expected retry messages must be clear and bounded.

## Exit checks

- Every failure case above has an automated proof.
- A retry does not duplicate rows or corrupt cursors.
- A crash does not leave the volume locked.
- No test leaves a daemon, watcher, server, or temporary directory running.
- [README.md](README.md) and this file both show `done`.
