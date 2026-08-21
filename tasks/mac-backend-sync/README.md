# Mac backend sync

Story status: `in progress`

This story connects the Mac file system to the existing backend Store. The backend and
OAuth path already support it. The work is in the native Store, the daemon, and the running
app refresh path.

Read this file before a phase file. A phase file contains its own scope and proof. Do not
split a phase between agents. The saved context costs more than the small gain from a second
agent.

## Product decisions

- The Mac app has no shipped user data. Use a new volume path. Do not write migration code.
- One macOS account has one Kodama user.
- An authenticated user ID change wipes the local volume and all sync metadata. Sign-out is
  also an ID change. A token refresh for the same ID does not wipe data.
- The daemon is the only writer for the native Store.
- `/private` is a local mount. Its children never enter the synced Store.
- Native file watch makes local uploads prompt. Remote pulls can use the normal sync timer.
- Remote sync does not turn on until pulled changes refresh the running Mac app.

## Progress

Status values are `todo`, `in progress`, `done`, and `blocked`.

| Phase | Work | Depends on | Size | Status |
| --- | --- | --- | --- | --- |
| 1 | [Make `fsStore` sync-ready](phase-1-fs-store.md) | None | Medium | done |
| 2 | [Make Mac storage safe](phase-2-mac-storage.md) | Phase 1 | Medium | done |
| 3 | [Connect sync and refresh the runtime](phase-3-connect-sync.md) | Phase 2 | Large | todo |
| 4 | [Test failure and recovery](phase-4-recovery.md) | Phase 3 | Small to medium | todo |

When a phase starts, set its row and its phase file to `in progress`. Set both to `done` only
after every exit check passes. Set the story status to `in progress` when Phase 1 starts and
to `done` when Phase 4 finishes.

## Dependency order

```text
Phase 1 -> Phase 2 -> Phase 3 -> Phase 4
```

Each phase starts after the prior phase merges. Every phase must leave the repository in a
working state:

- Phase 1 keeps all current stores working and leaves Mac local-only.
- Phase 2 keeps Mac local-only on the new safe storage layout.
- Phase 3 turns on sync only after live runtime refresh works.
- Phase 4 proves recovery. It does not introduce a second sync design.

## Shared design

The Store is both the storage API and the wire. Mac keeps a native main Store and joins a
second native Store at `/private`. Only the main Store is passed to `synced()`.

```text
Mac Volume
  main fsStore <-> synced() <-> httpStore('/store')
  /private     -> local fsStore
```

The sync wrapper needs a stable replica ID, pull cursor, push cursor, and discard bit. Keep
them outside the replicated main tree. The daemon owns both stores, the sync wrapper, and
their shutdown order.

The backend already provides the Store routes in
[`apps/frieren/worker/index.ts`](../../apps/frieren/worker/index.ts). Frieren provides the
working browser composition in [`apps/frieren/src/fs.ts`](../../apps/frieren/src/fs.ts).
Use these as references. Do not add a second wire protocol.

## Work rules

- Read [`docs/app.md`](../../docs/app.md) before Phases 2 and 3.
- Use pnpm, node, and vitest.
- Keep the `Store` and Mac file-system interfaces small.
- Write focused tests during a phase. Before completion, run the checks from the repository
  testing skill.
- Update this progress table in the same change that completes a phase.

## Story complete when

- A Finder edit reaches the backend without waiting for the full polling interval.
- A backend edit appears on disk and refreshes a running app when applicable.
- `/private` content never reaches the HTTP Store.
- A daemon race leaves one writer.
- A user ID change wipes local data before the new user connects.
- Restart, network loss, expired tokens, and interrupted sync all recover.
