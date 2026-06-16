---
title: '@justfiles/fs'
description: Filesystem storage primitives, path-based volume API, and sync.
---

# `@justfiles/fs`

Source: `packages/fs`

`@justfiles/fs` provides the filesystem substrate used by the app runtime and hosts. It keeps the core split into a minimal storage layer, a path-based volume layer, and optional sync.

## Layers

### Storage

`Storage` is the backend contract. It is intentionally small: metadata, blob content, and directory entries. Backends can opt into capabilities for atomic moves, ranges, xattrs, scans, deltas, batches, and change feeds.

### Volume

`volume(storage)` builds the path API on top of `Storage`: `stat`, `readFile`, `writeFile`, `mkdir`, `readdir`, `rm`, `rename`, `cp`, symlinks, xattrs, tree scan, and watch.

### Sync

`synced({ local, remote })` creates a local-first synced volume. It pushes local changes, pulls remote deltas, supports lazy content hydration, and exposes `flush`, `pause`, `resume`, `destroy`, and sync status.

## Backends

- `@justfiles/fs/storage/mem` — in-memory storage.
- `@justfiles/fs/storage/idb` — IndexedDB storage for browser profiles.
- `@justfiles/fs/storage/fs` — native filesystem storage for Node hosts.

## Key files

- `packages/fs/storage.ts` — backend interface and capabilities.
- `packages/fs/volume.ts` — path API.
- `packages/fs/synced.ts` — local/remote replication.
- `packages/fs/types.ts` — inode, stat, and dirent types.
- `packages/fs/xattr.ts` — extended attribute encoding.

## Commands

```sh
pnpm --filter @justfiles/fs typecheck
```

## TODO

- Document backend invariants for implementers.
- Add examples for browser IDB and native filesystem volumes.
- Document sync conflict behavior and local-only paths.
