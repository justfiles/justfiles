# Current Status

This milestone landed the first end-to-end filesystem-backed note flow:

- worker-side SQLite filesystem backend with `fs_*` tables
- `/fs` REST API mounted through the worker
- typed Hono FS client in the React app
- FS-backed draft load/save/submit flow
- FS-backed sidebar scan and note open flow
- FS-backed asset upload and preview flow under the hidden `/.assets` namespace
- local-first metadata/content caching improvements
- single-flight and exclusivity utilities for repeated path resolution and sync work

# Done

- Replaced the `any`-typed FS client path with a typed Hono client in [`apps/worker/src/react-app/storage.api.ts`](./apps/worker/src/react-app/storage.api.ts).
- Added the SQLite filesystem schema in [`packages/core/src/migrations/0005_fs_schema.sql`](./packages/core/src/migrations/0005_fs_schema.sql) and the backend implementation in [`packages/core/src/storage.sqlite.ts`](./packages/core/src/storage.sqlite.ts).
- Added the worker FS API in [`packages/core/src/fs.ts`](./packages/core/src/fs.ts) and mounted it through the worker app.
- Moved the landing-page draft flow off the legacy draft API and onto the filesystem in [`apps/worker/src/react-app/draft.ts`](./apps/worker/src/react-app/draft.ts).
- Moved sidebar bootstrap and note resolution off `/api/v1/changes` and `/api/v1/memory/:id` and onto FS scan/read in [`apps/worker/src/react-app/useVolume.ts`](./apps/worker/src/react-app/useVolume.ts).
- Moved note archive/revive off the legacy memory endpoints and into the React app's FS runtime in [`apps/worker/src/react-app/useVolume.ts`](./apps/worker/src/react-app/useVolume.ts), using a hidden `/.trash` namespace plus restore metadata sidecars.
- Moved image and drawing assets off the legacy memory asset API and into the filesystem in [`apps/worker/src/react-app/assets.ts`](./apps/worker/src/react-app/assets.ts), [`apps/worker/src/react-app/useVolume.ts`](./apps/worker/src/react-app/useVolume.ts), and the editor node views/plugins, using absolute `/.assets/<uuid><ext>` paths plus the new content-serving route in [`packages/core/src/fs.ts`](./packages/core/src/fs.ts).
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
- Finished remote xattr sync application and source-aware journal filtering by:
	- applying `op.xattrs` during delta sync in [`packages/fs/storage.cached.ts`](./packages/fs/storage.cached.ts)
	- tagging journaled ops with a per-client `source` in [`packages/fs/storage.ts`](./packages/fs/storage.ts)
	- excluding the caller's own source in `/updates` via [`packages/core/src/fs.ts`](./packages/core/src/fs.ts) and the worker SQLite journal in [`packages/core/src/storage.sqlite.ts`](./packages/core/src/storage.sqlite.ts)
	- covering remote-xattr hydration and legacy source-less local op replay in [`packages/fs/storage.cached.test.js`](./packages/fs/storage.cached.test.js)

# Remaining Gaps

- Medium: the namespace is still remote-authoritative. [`packages/fs/storage.cached.ts`](./packages/fs/storage.cached.ts) still delegates `dirList`, `dirAdd`, `dirSet`, `dirUnset`, and `rename` to remote immediately. This is acceptable for the current milestone, but it is not yet a fully local-first tree model.
- Medium: the local outbound op log still has no compaction/ack cleanup path. [`packages/fs/storage.idb.ts`](./packages/fs/storage.idb.ts) can read `updates`, but old local ops will accumulate indefinitely.
- Low: revisit the local journal representation. The current browser backend keeps its outbound op log in an IndexedDB `updates` store, which is pragmatic for now, but the original design intent was to model sync state as filesystem data under `/.state/`. If we want the local backend to be more purely filesystem-shaped, consider moving the local journal to `/.state` log files and keeping the DB-backed `fs_updates` table only on the authoritative worker side.
- Low: asset serving is correct but not fully simplified yet. The editor currently loads authenticated blobs through the FS client instead of rendering directly from the cacheable `/fs/inodes/:ino/content/:filename` URL, and the legacy `/api/v1/memory/:memoryId/assets` worker routes are still mounted as dead code.

# Next Milestone

Focus the next round on finishing the FS boundary instead of broadening scope:

1. Decide whether to remove the legacy memory asset routes now and whether preview rendering should switch to cacheable FS content URLs directly.
2. Revisit whether local-first namespace operations are worth doing now or can wait for a later milestone.
3. Add retention and purge policy for `/.trash` once the lifecycle semantics are stable.
