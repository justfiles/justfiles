# Designing a Filesystem Abstraction in TypeScript

A two-layer architecture inspired by the Linux kernel's VFS (Virtual File System) design. The goal: a minimal set of interfaces that let you build any filesystem tooling on top, while keeping the implementation surface as small as possible.

The primary use case is an AI agent filesystem: files synced to a cloud backend, shared across agent instances, accessed via shell-like tools. Backend calls may be cloud API round trips — **minimising call count is a first-class concern.**

---

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│  Userland Tools (ls, mkdir, rm, cat, cp...) │
├─────────────────────────────────────────────┤
│  VFS Layer (FileSystem interface)           │
│  Fd table, path resolution, permissions,    │
│  symlink traversal, open/close semantics,   │
│  metadata cache, content cache              │
├─────────────────────────────────────────────┤
│  Storage Backend (StorageBackend interface) │
│  Raw inode CRUD, byte I/O, directory entries│
├─────────────────────────────────────────────┤
│  Actual Storage (local disk, S3+DynamoDB,   │
│  IndexedDB, SQLite, in-memory, etc.)        │
└─────────────────────────────────────────────┘
```

There are two distinct interfaces:

1. **`FileSystem`** — the consumer-facing VFS layer. Higher-level tools (`ls`, `mkdir`, `rm`) are built on top of this. It deals in file descriptors, paths (via `lookup`), open flags, and POSIX-like semantics.

2. **`StorageBackend`** — the implementor-facing layer. This is what you actually write when building a new filesystem. It's pure storage: allocate inodes, read/write bytes, manage name→inode mappings. No Fds, no paths, no permissions logic.

The VFS sits between them, translating consumer calls into backend primitives — and caching aggressively to avoid redundant round trips.

---

## Layer 1: The VFS Interface (`FileSystem`)

This is the contract between the kernel and userland. Higher-level tools consume this interface. It operates on **inodes**, not paths — path resolution is built on top via repeated `lookup` calls.

### Shared Types

see ./types.ts

### The Interface

see ./fs.ts

### Key Design Decisions

**Why `pread`/`pwrite` instead of `read`/`write` + `seek`:** A read/seek design hides a mutable cursor inside the Fd. That means concurrent access to the same Fd needs synchronization, and you need a separate `seek` operation. Positional I/O eliminates that — the offset is an explicit argument, so the Fd itself is stateless. If a higher layer wants a cursor, it wraps an Fd with a position counter. That's a 3-line abstraction, not a kernel-level concern.

**Why `lookup` exists separately from `readdir`:** Path resolution calls `lookup` on each component (`/foo/bar/baz` → lookup "foo", lookup "bar", lookup "baz"). You don't want to dump an entire directory listing to find one name. An FS implementation can back `lookup` with a hash table or B-tree for O(1)/O(log n), while `readdir` iterates sequentially.

**Hard link reference counting is backend-internal:** `nlink` is managed entirely inside `dirAdd`, `dirSet`, and `dirUnset`. The VFS never calls a separate increment, decrement, or free operation. When `dirAdd` or `dirSet` adds a directory entry it atomically increments nlink on the target inode; when `dirUnset` removes an entry it atomically decrements nlink and frees the inode if the count reaches 0. This makes `link()` and `unlink()` single-call operations with no crash window and no concurrency race — the VFS simply adds or removes a directory entry and the backend handles the rest.

New inodes start at `nlink = 0` (not 1). The first `dirAdd` call (from `mknod` or `create?`) brings nlink to 1. This keeps the semantics consistent: every directory entry is one nlink unit, and `alloc` without a subsequent `dirAdd` is the only orphan case — which `create?` closes atomically.

**What's deliberately omitted:**
- `chmod`/`chown` — folded into `setattr`.
- Any path-based API — built on top via `resolve(root, path)` using `lookup`.
- `dup`/`dup2` — Fd table management is an OS concern, not a FS concern.

---

## Layer 2: The Storage Backend (`StorageBackend`)

This is the contract between the VFS and the actual storage medium. This is what you implement when building a new filesystem. It's pure storage primitives — no Fds, no paths, no permissions logic, no symlink traversal. The VFS handles all of that.

A filesystem is fundamentally: **"a pool of numbered blobs with metadata, plus a naming layer."**

### The Interface

see ./storage.ts

### Key Design Decisions in the Backend

**`contentHash` in `InodeMeta`:** The backend sets this on every write (SHA-256 of the full content). Two higher-layer concerns consume it without reading file content:
- **Sync**: compare `contentHash` between local and remote to decide what to upload.
- **Embedding pipeline**: a semantic search layer above the VFS chunks files into paragraph-sized pieces and embeds them. Before re-embedding a file, it checks whether `contentHash` changed since the last embedding run. If not, it skips the file entirely. The pipeline itself lives above the VFS — it reads files via the normal interface and manages its own vector store — but it relies on `contentHash` as a stable change signal.

CDC-style chunk-level diffing was considered but rejected: the files this filesystem targets (markdown notes, configs, agent context) are typically small enough to fit in a single CDC chunk, so the diff machinery would add complexity with no bandwidth saving. `contentHash` provides the change signal at a fraction of the complexity.

**`dirAdd` vs `dirSet` — two distinct insert semantics:** These are intentionally separate primitives, not one method with a flag.

- **`dirAdd(dirIno, name, ino, type) → boolean`** is no-clobber: it adds the entry and increments nlink atomically, returning `false` (without modifying anything) if the name already exists. This is the primitive for `mknod` (after `alloc`) and `link()`. A single atomic check-and-insert eliminates the TOCTOU race where a pre-lookup + insert pair would let two concurrent callers both see "name is free" and both proceed.
- **`dirSet(dirIno, name, ino, type) → DirentMin | null`** is unconditional: it always inserts or replaces, atomically managing nlink on both the incoming ino and any displaced entry. This is the primitive for the rename overwrite path — the one place that legitimately replaces an existing name.

**`dirLookup` and `dirUnset` return `DirentMin | null`:** Both return `{ ino, type }` rather than just `Ino`. The synthesised rename calls `dirLookup(oldDir, oldName)` and then immediately calls `dirSet(newDir, newName, ino, type)` — it needs `type` for that second call. Without `type` in the lookup result, an extra `getMeta` would be required. `dirSet` and `dirUnset` return the displaced/removed entry so the VFS can invalidate its cache without any additional lookups.

**Optional `create?(dirIno, name, meta) → Ino`:** Backends with transactional writes (DynamoDB, SQLite, Postgres) implement this to make `mknod` atomic — a single operation that allocates the inode and inserts the directory entry together. Without it, the VFS falls back to `alloc()` + `dirAdd()`, which has a failure window (orphaned inode with nlink = 0). Like `dirAdd`, `create?` is no-clobber: it rejects if the name already exists.

**Optional `rename?(oldDir, oldName, newDir, newName) → Ino | null`:** Atomic rename is available in almost every real storage system (POSIX, SQLite, DynamoDB transactions). Without this, the VFS synthesises rename as `dirLookup + dirSet + dirUnset`. Because `dirSet` increments nlink and `dirUnset` decrements it, the synthesised path is safe with respect to inode lifetime — nlink is temporarily 2 during the operation but the inode is never freed prematurely. The only downside of the fallback is a window where both names exist simultaneously. `rename?()` closes that window. Returns the displaced ino (if newName already existed) for cache invalidation; the displaced inode's lifetime is handled atomically inside the backend implementation.

**Optional `putBlob?(ino, data)`:** Object stores (S3, R2, GCS) don't support partial writes — every mutation is a full object PUT. If the VFS called `write(ino, offset, data)` for a partial update, the backend would have to GET the current content, splice in the new bytes, then PUT the whole thing — an expensive read-modify-write cycle. `putBlob` lets the VFS signal "here is the complete new content" when it has a full document in hand, enabling a single PUT with no prior GET. Backends that support efficient partial writes (local disk, databases) ignore this method.

---

## How the VFS Composes Backend Primitives

The VFS translates every consumer-facing operation into a sequence of backend calls. RTT counts assume no cache hits; see the Caching section for how the VFS amortizes these costs.

### `open(ino, flags) → Fd`

```
VFS: open(ino, flags)
  → VFS checks metadata cache for ino
  → if miss: backend.getMeta(ino)    // 1 RTT — or 0 if recently stat'd
  → cache meta, allocate Fd in VFS table
```

A `stat(ino)` immediately before `open(ino)` costs 0 extra RTTs — the metadata cache absorbs it.

### `pread(fd, buf, offset) → number`

```
VFS: pread(fd, buf, offset)
  → VFS looks up ino from its Fd table
  → VFS checks content cache for (ino, range)
  → if hit: copy from cache, 0 RTTs
  → if miss: backend.read(ino, offset, buf.length)    // 1 RTT
  → populate content cache
```

### `close(fd)`

```
VFS: close(fd)
  → VFS removes Fd from table. No backend call.
```

### `mknod(dirIno, name, type, mode) → Ino`

```
VFS: mknod(dirIno, name, type, mode)
  → if backend.create?:
      backend.create(dirIno, name, { type, mode, size: 0n, ... })  // 1 RTT, atomic, no-clobber
  → else:
      backend.alloc({ type, mode, size: 0n, ... })    // RTT 1
      backend.dirAdd(dirIno, name, newIno, type)       // RTT 2, no-clobber (false → EEXIST)
  → evict directory cache for dirIno
```

### `unlink(dirIno, name)`

```
VFS: unlink(dirIno, name)
  → backend.dirUnset(dirIno, name)   // remove entry; backend atomically
                                     // decrements nlink and frees if hits 0  [RTT 1]
  → evict ino from metadata + content caches
  → evict (dirIno, name) from directory cache
```

1 RTT. No separate free step. No crash window. Safe across concurrent VFS instances.

### `link(dirIno, name, targetIno)`

```
VFS: link(dirIno, name, targetIno)
  → VFS fetches type from metadata cache (0 RTTs if recently stat'd)
  → backend.dirAdd(dirIno, name, targetIno, type)   // no-clobber insert; backend atomically
                                                     // increments nlink             [RTT 1]
                                                     // returns false → VFS throws EEXIST
```

1 RTT. No separate linkInc step. No crash window. TOCTOU-safe.

### `rename` (synthesised, or native if backend supports it)

```
VFS: rename(oldDir, oldName, newDir, newName)
  → if backend.rename?:
      backend.rename(oldDir, oldName, newDir, newName)  // 1 RTT, atomic
  → else:
      backend.dirLookup(oldDir, oldName)                // RTT 1 → {ino, type}
      backend.dirSet(newDir, newName, ino, type)        // RTT 2 → displaced | null
        // ↑ nlink(ino) temporarily +1; displaced inode freed inside backend if needed
      backend.dirUnset(oldDir, oldName)                 // RTT 3 → nlink(ino) back to original
  → update directory caches; evict displaced ino if any
```

The synthesised path is safe with respect to inode lifetime: nlink goes +1 then -1, net zero.
The inode is never freed prematurely even without `rename?()`. The only downside is a window
where both names exist simultaneously. `rename?()` closes that window.

### `fsync(fd)`

```
VFS: fsync(fd)
  → backend might not need it. An S3 backend is durable on write().
     A local-file backend delegates to the OS.
     The VFS flushes any pending writes and refreshes the content cache entry.
```

---

## VFS Caching Layer

The VFS maintains two in-memory caches to amortize backend round trips. For a cloud-backed filesystem where each backend call is a network request, caching is not optional — it's what makes the interface usable.

### Metadata Cache

Maps `ino → InodeMeta` with a configurable TTL (default: 30s). Also caches directory lookups: `(dirIno, name) → Ino | null`, including **negative entries** (null = "this name does not exist in this directory").

**How it helps:**

- `stat(ino)` followed by `open(ino)` costs 1 RTT total, not 2. The `open` reads from cache.
- Path resolution of `/a/b/c` makes 3 `dirLookup` calls on the first traversal. Subsequent traversals of the same path cost 0 RTTs.
- Symlink traversal reads `symlinkTarget` from `getMeta`. Symlink chains are cached after the first traversal.
- A tool that calls `stat` in a loop (e.g., `ls` checking each entry's type) costs 1 RTT for the directory listing plus 0 RTTs for stats of already-seen inodes.

**Invalidation:**

| Event                            | Evicts                                |
|----------------------------------|---------------------------------------|
| `pwrite` or `truncate` on ino    | ino metadata (size + mtime changed)   |
| `setattr` on ino                 | ino metadata                          |
| `dirSet` or `dirUnset` on dirIno | all `(dirIno, *)` directory entries   |
| `mknod` in dirIno                | `(dirIno, name)` directory entry      |
| TTL expiry                       | entry evicted, next access re-fetches |

**Sizing:** Metadata entries are small (< 256 bytes). A count-based limit (e.g., 4096 entries) is sufficient — no byte accounting needed.

### Content Cache

Maps `ino → Uint8Array` for recently-read file content. Backed by an **LRU eviction policy** with a configurable total byte cap (default: 32 MB).

Only files up to a per-entry size threshold (default: 4 MB) are eligible for caching. Files larger than the threshold are read directly without caching — they'd evict many small cached files for a single read, destroying cache utility.

**How it helps:**

- An agent reading the same config file, prompt template, or document on every turn pays for 1 backend read across all turns.
- `cat` becomes: `open` (0 RTTs if meta cached) + `pread` (0 RTTs if content cached). Zero backend calls for a file read repeatedly.
- Tools that scan a directory and read each file pay full cost on the first pass, then serve from cache on any repeated access.

**How `pread` uses the cache:**

The content cache stores the full file content. On `pread(fd, buf, offset)`:
1. Check content cache for the ino.
2. If present and the cached content covers `[offset, offset+len)`: copy from cache, no backend call.
3. If absent or stale: call `backend.read(ino, 0, size)` to load the full file, populate cache, then serve the requested slice.

Reading the full file on a cache miss (rather than just the requested slice) means subsequent `pread` calls at any offset are served from cache. This is optimal for the agent use case, where files are small documents read in their entirety.

**Invalidation:**

| Event             | Action                                                     |
|-------------------|------------------------------------------------------------|
| `pwrite` to ino   | evict ino from content cache immediately                   |
| `truncate` on ino | evict ino from content cache immediately                   |
| `putBlob` on ino  | replace content cache entry with new content               |
| LRU eviction      | least-recently-accessed entry removed when cap is exceeded |

**Sizing example:** A 32 MB cap with a 4 MB per-file threshold means the cache holds at minimum 8 files, typically many more for small agent context files (prompts, configs, notes tend to be < 64 KB each, so the same cap holds ~500 of them).

---

## What the Backend Does NOT Handle

These are all handled by the VFS layer:

| Concept                    | Where it lives | How                                                             |
|----------------------------|----------------|-----------------------------------------------------------------|
| File descriptors (`Fd`)    | VFS            | In-memory table mapping Fd → ino + flags                        |
| Path resolution            | VFS            | Loop calling `dirLookup()` per component, served from dir cache |
| `open` / `close` semantics | VFS            | `getMeta` (cached) + Fd table bookkeeping                       |
| Permission checks          | VFS            | Reads `mode` from `getMeta`, decides                            |
| Symlink traversal          | VFS            | Reads `symlinkTarget` from `getMeta`, recurses                  |
| Hard link count (`nlink`)  | Backend        | Managed inside `dirAdd` / `dirSet` / `dirUnset`; frees at 0     |
| `rename` (non-atomic)      | VFS            | `dirLookup` + `dirSet` + `dirUnset` (or native `rename?`)       |
| `chmod` / `chown`          | VFS            | `setattr`                                                       |
| `fsync`                    | VFS / optional | Many backends are durable on write                              |
| Metadata caching           | VFS            | `ino → InodeMeta` map with TTL + invalidation                   |
| Directory entry caching    | VFS            | `(dirIno, name) → Ino` map with invalidation                    |
| Content caching            | VFS            | LRU `ino → Uint8Array` map with byte cap                        |

---

## Building Userland Tools on the VFS

With the VFS in place, every familiar shell command becomes a thin composition:

### Path Resolution

```typescript
async function resolve(fs: FileSystem, path: string): Promise<Ino> {
  const parts = path.split('/').filter(Boolean);
  let ino = fs.root();
  for (const name of parts) {
    const next = await fs.lookup(ino, name);
    if (next === null) throw new Error(`ENOENT: ${name}`);
    // optionally: stat to check for symlinks and recurse
    ino = next;
  }
  return ino;
}
```

### `mkdir`

```typescript
async function mkdir(fs: FileSystem, path: string, mode = 0o755) {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop()!;
  const parentIno = await resolve(fs, parts.join('/'));
  await fs.mknod(parentIno, name, FileType.Directory, mode);
}
```

### `ls`

```typescript
async function ls(fs: FileSystem, path: string): Promise<Dirent[]> {
  const ino = await resolve(fs, path);
  const entries: Dirent[] = [];
  let cursor = '';
  do {
    const batch = await fs.readdir(ino, cursor);
    entries.push(...batch.entries);
    cursor = batch.next;
  } while (cursor !== '');
  return entries;
}
```

### `cat`

```typescript
async function cat(fs: FileSystem, path: string): Promise<Uint8Array> {
  const ino = await resolve(fs, path);
  // stat + open share the same metadata cache hit — only 1 backend call total
  const info = await fs.stat(ino);
  const fd = await fs.open(ino, OpenFlags.Read);
  try {
    const buf = new Uint8Array(Number(info.size));
    await fs.pread(fd, buf, 0n);  // served from content cache on repeat calls
    return buf;
  } finally {
    await fs.close(fd);
  }
}
```

### `rm`

```typescript
async function rm(fs: FileSystem, path: string) {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop()!;
  const parentIno = await resolve(fs, parts.join('/'));
  await fs.unlink(parentIno, name);
}
```

### `cp`

```typescript
async function cp(fs: FileSystem, src: string, dst: string) {
  const srcIno = await resolve(fs, src);
  const dstParts = dst.split('/').filter(Boolean);
  const dstName = dstParts.pop()!;
  const dstParent = await resolve(fs, dstParts.join('/'));

  const srcStat = await fs.stat(srcIno);
  const newIno = await fs.mknod(dstParent, dstName, FileType.Regular, srcStat.mode);

  const srcFd = await fs.open(srcIno, OpenFlags.Read);
  const dstFd = await fs.open(newIno, OpenFlags.Write);
  try {
    const chunkSize = 64 * 1024;
    const buf = new Uint8Array(chunkSize);
    let off = 0n;
    let n: number;
    while ((n = await fs.pread(srcFd, buf, off)) > 0) {
      await fs.pwrite(dstFd, buf.subarray(0, n), off);
      off += BigInt(n);
    }
  } finally {
    await fs.close(srcFd);
    await fs.close(dstFd);
  }
}
```

---

## Example Backend Implementations

The backend interface can be implemented against wildly different storage media:

### In-Memory

`alloc` → push to a `Map<Ino, { meta, data, dir }>`. `read`/`write` → slice/copy `Uint8Array`. `dirLookup` → `Map.get`, returns `{ ino, type } | null`. `dirAdd` → insert-if-absent + nlink increment, returns `false` on conflict. `dirUnset` → `Map.delete`, returns `{ ino, type } | null`. Useful for testing and ephemeral workloads.

### Local Filesystem

`alloc` → create a file in a flat directory named by ino. `read`/`write` → `fs.read`/`fs.write` with position. `dirLookup`/`dirAdd`/`dirSet`/`dirUnset` → maintain a JSON or SQLite index per directory inode; `dirAdd` and `dirUnset` update the nlink counter atomically. Implements `rename?` natively via `fs.rename`.

### S3 + DynamoDB

`alloc` → `INSERT` into DynamoDB (partition key = ino, nlink = 0). `read`/`write` → S3 `GetObject`/`PutObject` with `Range` header for reads. `putBlob?` → direct S3 `PutObject` (no read needed). `create?` → DynamoDB transaction: insert inode row + insert dirent row + set nlink = 1, atomically. `dirLookup` → DynamoDB query on `(parent_ino, name)` GSI, returns `{ ino, type } | null`. `dirAdd` → DynamoDB conditional `PutItem` (fails if exists) + atomic nlink increment. `dirUnset` → DynamoDB `DeleteItem` with return values to get `{ ino, type }` + atomic nlink decrement + conditional inode delete if nlink = 0.

### SQLite

`alloc` → `INSERT INTO inodes` (nlink = 0). `read`/`write` → blob I/O or chunked rows. `dirLookup` → `SELECT ino, type FROM dirents WHERE parent = ? AND name = ?`. `dirAdd` → transaction: `INSERT INTO dirents` (fail if exists) + `UPDATE inodes SET nlink = nlink + 1`; returns false on conflict without modifying anything. `dirSet` → transaction: `INSERT OR REPLACE INTO dirents` + `UPDATE inodes SET nlink = nlink + 1` on new ino + `UPDATE/DELETE` displaced ino nlink if applicable. `dirUnset` → transaction: `DELETE FROM dirents RETURNING ino, type` + `UPDATE inodes SET nlink = nlink - 1` + `DELETE` inode if nlink = 0. `create?` → single transaction: insert inode + `dirAdd` semantics atomically. `rename?` → single transaction updating the dirent row, handling displaced inode nlink atomically. Compact, single-file, good for embedded use.

### IndexedDB (Browser)

`alloc` → put into an `inodes` object store. `read`/`write` → get/put `ArrayBuffer` in a `data` store keyed by `(ino, chunkIndex)`. `putBlob?` → single put of the entire content. `dirLookup` → index on `[parentIno, name]`. Enables a full filesystem in the browser.

---

## Summary

The entire design is two interfaces plus a caching layer:

- **`StorageBackend`** (11 required methods + 3 optional) — what you implement per storage medium. Optional methods (`create?`, `rename?`, `putBlob?`) let capable backends upgrade to atomic operations where the required primitives have multi-step fallbacks.
- **`FileSystem`** (13 methods) — what tools consume, provided by the VFS.
- **VFS Caching** (metadata cache + content cache) — amortizes cloud round trips so the interface stays practical at network latency.

The VFS layer handles Fd management, path resolution, permission checks, symlink traversal, operation composition, and caching. Every shell command is a thin wrapper over the VFS. Every storage medium is a thin implementation of the backend.
