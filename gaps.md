# Current Status

This milestone landed the first end-to-end filesystem-backed note flow:

- worker-side SQLite filesystem backend with `fs_*` tables
- `/fs` REST API mounted through the worker
- typed Hono FS client in the React app
- FS-backed draft load/save/submit flow
- FS-backed sidebar scan and note open flow
- local-first metadata/content caching improvements
- single-flight and exclusivity utilities for repeated path resolution and sync work

# Done

- Replaced the `any`-typed FS client path with a typed Hono client in [`apps/worker/src/react-app/storage.api.ts`](./apps/worker/src/react-app/storage.api.ts).
- Added the SQLite filesystem schema in [`packages/core/src/migrations/0005_fs_schema.sql`](./packages/core/src/migrations/0005_fs_schema.sql) and the backend implementation in [`packages/core/src/storage.sqlite.ts`](./packages/core/src/storage.sqlite.ts).
- Added the worker FS API in [`packages/core/src/fs.ts`](./packages/core/src/fs.ts) and mounted it through the worker app.
- Moved the landing-page draft flow off the legacy draft API and onto the filesystem in [`apps/worker/src/react-app/draft.ts`](./apps/worker/src/react-app/draft.ts).
- Moved sidebar bootstrap and note resolution off `/api/v1/changes` and `/api/v1/memory/:id` and onto FS scan/read in [`apps/worker/src/react-app/useVolume.ts`](./apps/worker/src/react-app/useVolume.ts).
- Moved note archive/revive off the legacy memory endpoints and into the React app's FS runtime in [`apps/worker/src/react-app/useVolume.ts`](./apps/worker/src/react-app/useVolume.ts), using a hidden `/.trash` namespace plus restore metadata sidecars.
- Reduced startup/open request fanout by:
	- removing eager per-file xattr fetches during sidebar bootstrap
	- making inode metadata local-first in [`packages/fs/storage.cached.ts`](./packages/fs/storage.cached.ts)
	- seeding VFS caches from scan results in [`packages/fs/fs.ts`](./packages/fs/fs.ts)
	- adding reusable single-flight request dedupe in [`packages/fs/singleFlight.ts`](./packages/fs/singleFlight.ts)
- Fixed shared-cursor and repeated-op sync issues by:
	- serializing shared sync-log drains
	- serializing per-inode flush work
	- coalescing repeated inode upserts before remote replay
	- centralizing exclusivity helpers in [`packages/fs/exclusive.ts`](./packages/fs/exclusive.ts)

# Remaining Gaps

- High: asset upload and preview is still legacy-memory based. [`apps/worker/src/react-app/MemoryEditor.tsx`](./apps/worker/src/react-app/MemoryEditor.tsx) forwards `assetOwnerId` into the editor, and image/drawing code still posts to `/api/v1/memory/:id/assets`. For FS notes, that `id` is an inode, so assets are not yet part of the new filesystem flow.
- Medium: remote xattr sync is incomplete. The new FS backend emits xattrs in `/updates`, but delta sync in [`packages/fs/storage.cached.ts`](./packages/fs/storage.cached.ts) only applies `op.meta` and `contentChanged`. Title/tags/source/links are therefore not reliably hydrated across devices.
- Medium: the namespace is still remote-authoritative. [`packages/fs/storage.cached.ts`](./packages/fs/storage.cached.ts) still delegates `dirList`, `dirAdd`, `dirSet`, `dirUnset`, and `rename` to remote immediately. This is acceptable for the current milestone, but it is not yet a fully local-first tree model.
- Medium: the local outbound op log still has no compaction/ack cleanup path. [`packages/fs/storage.idb.ts`](./packages/fs/storage.idb.ts) can read `updates`, but old local ops will accumulate indefinitely.

# Next Milestone

Focus the next round on finishing the FS boundary instead of broadening scope:

1. Decide whether assets move into the FS backend now or are explicitly disabled for FS-backed notes until that work is done.
2. Finish xattr sync application on the local side so cross-device title/tags/source/links behave correctly.
3. Only after that, revisit whether local-first namespace operations are worth doing now or can wait for a later milestone.
4. Add retention and purge policy for `/.trash` once the lifecycle semantics are stable.
