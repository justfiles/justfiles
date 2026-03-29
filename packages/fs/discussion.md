# Designing a Filesystem Abstraction in TypeScript

A two-layer architecture inspired by the Linux kernel's VFS (Virtual File System) design. The goal: a minimal set of interfaces that let you build any filesystem tooling on top, while keeping the implementation surface as small as possible.

---

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│  Userland Tools (ls, mkdir, rm, cat, cp...) │
├─────────────────────────────────────────────┤
│  VFS Layer (FileSystem interface)           │
│  Fd table, path resolution, permissions,    │
│  symlink traversal, open/close semantics    │
├─────────────────────────────────────────────┤
│  Storage Backend (StorageBackend interface)  │
│  Raw inode CRUD, byte I/O, directory entries │
├─────────────────────────────────────────────┤
│  Actual Storage (local disk, S3+DynamoDB,   │
│  IndexedDB, SQLite, in-memory, etc.)        │
└─────────────────────────────────────────────┘
```

There are two distinct interfaces:

1. **`FileSystem`** — the consumer-facing VFS layer. Higher-level tools (`ls`, `mkdir`, `rm`) are built on top of this. It deals in file descriptors, paths (via `lookup`), open flags, and POSIX-like semantics.

2. **`StorageBackend`** — the implementor-facing layer. This is what you actually write when building a new filesystem. It's pure storage: allocate inodes, read/write bytes, manage name→inode mappings. No Fds, no paths, no permissions logic.

The VFS sits between them, translating consumer calls into backend primitives.

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

**What's deliberately omitted:**
- `rename` — it's `link` + `unlink` at this level, or a higher layer adds it as an atomic operation if the FS supports it.
- `chmod`/`chown` — folded into `setattr`.
- Any path-based API — built on top via `resolve(root, path)` using `lookup`.
- `dup`/`dup2` — Fd table management is an OS concern, not a FS concern.

---

## Layer 2: The Storage Backend (`StorageBackend`)

This is the contract between the VFS and the actual storage medium. This is what you implement when building a new filesystem. It's pure storage primitives — no Fds, no paths, no permissions logic, no symlink traversal. The VFS handles all of that.

A filesystem is fundamentally: **"a pool of numbered blobs with metadata, plus a naming layer."**

### The Interface

see ./storage.ts

---

## How the VFS Composes Backend Primitives

The VFS translates every consumer-facing operation into a sequence of backend calls. Here's the mapping:

### `open(ino, flags) → Fd`

```
VFS: open(ino, flags)
  → backend.getMeta(ino)          // check existence + permissions
  → VFS allocates Fd in its own table, done.
     No backend call — Fds are a VFS-level concept.
```

### `pread(fd, buf, offset) → number`

```
VFS: pread(fd, buf, offset)
  → VFS looks up ino from its Fd table
  → backend.read(ino, offset, buf.length)
```

### `close(fd)`

```
VFS: close(fd)
  → VFS removes Fd from table
  → if nlink == 0 and last Fd: backend.free(ino)
     Otherwise: no backend call at all.
```

### `mknod(dirIno, name, type, mode) → Ino`

```
VFS: mknod(dirIno, name, type, mode)
  → backend.alloc({ type, mode, size: 0n, nlink: 1, ... })
  → backend.dirSet(dirIno, name, newIno, type)
```

### `unlink(dirIno, name)`

```
VFS: unlink(dirIno, name)
  → backend.dirLookup(dirIno, name)       // get target ino
  → backend.dirUnset(dirIno, name)         // remove name
  → backend.getMeta(ino)                   // get nlink
  → backend.setMeta(ino, { nlink: n-1 })   // decrement
  → if nlink == 0: backend.free(ino)
```

### `rename` (synthesized from link + unlink)

```
VFS: rename(oldDir, oldName, newDir, newName)
  → backend.dirLookup(oldDir, oldName)
  → backend.dirSet(newDir, newName, ino, type)
  → backend.dirUnset(oldDir, oldName)
     nlink unchanged for regular rename.
```

### `fsync(fd)`

```
VFS: fsync(fd)
  → This is interesting. The backend might not need it.
     An S3 backend is durable on write(). A local-file
     backend delegates to the OS. The VFS can add an
     optional flush?(ino): Promise<void> if needed,
     but it's not in the core 10 because not every
     backend has a concept of buffering.
```

---

## What the Backend Does NOT Handle

These are all synthesized by the VFS from the 10 backend methods:

| Concept                    | Where it lives | How                                              |
|----------------------------|----------------|--------------------------------------------------|
| File descriptors (`Fd`)    | VFS            | In-memory table mapping Fd → ino + flags         |
| Path resolution            | VFS            | Loop calling `backend.dirLookup()` per component |
| `open` / `close` semantics | VFS            | `getMeta` + Fd table bookkeeping                 |
| Permission checks          | VFS            | Reads `mode` from `getMeta`, decides             |
| Symlink traversal          | VFS            | Reads `symlinkTarget` from `getMeta`, recurses   |
| Hard link count management | VFS            | Increments/decrements via `setMeta`              |
| `rename`                   | VFS            | `dirLookup` + `dirSet` + `dirUnset`              |
| `chmod` / `chown`          | VFS            | `setMeta`                                        |
| `fsync`                    | VFS / optional | Many backends are durable on write               |

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
  let cursor = 0n;
  do {
    const batch = await fs.readdir(ino, cursor);
    entries.push(...batch.entries);
    cursor = batch.next;
  } while (cursor !== 0n);
  return entries;
}
```

### `cat`

```typescript
async function cat(fs: FileSystem, path: string): Promise<Uint8Array> {
  const ino = await resolve(fs, path);
  const fd = await fs.open(ino, OpenFlags.Read);
  try {
    const info = await fs.stat(ino);
    const buf = new Uint8Array(Number(info.size));
    await fs.pread(fd, buf, 0n);
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

The 10-method backend interface can be implemented against wildly different storage media:

### In-Memory

`alloc` → push to a `Map<Ino, { meta, data, dir }>`. `read`/`write` → slice/copy `Uint8Array`. `dirLookup` → `Map.get`. Useful for testing and ephemeral workloads.

### Local Filesystem

`alloc` → create a file in a flat directory named by ino. `read`/`write` → `fs.read`/`fs.write` with position. `dirLookup`/`dirSet`/`dirUnset` → maintain a JSON or SQLite index per directory inode.

### S3 + DynamoDB

`alloc` → insert a row in DynamoDB (partition key = ino). `read`/`write` → S3 `GetObject`/`PutObject` with `Range` header. `dirLookup` → DynamoDB query on `(parent_ino, name)` GSI. `truncate` → S3 copy-to-self with truncated range or delete + re-put.

### SQLite

`alloc` → `INSERT INTO inodes`. `read`/`write` → blob I/O or chunked rows. `dirLookup` → `SELECT ino FROM dirents WHERE parent = ? AND name = ?`. Compact, single-file, good for embedded use.

### IndexedDB (Browser)

`alloc` → put into an `inodes` object store. `read`/`write` → get/put `ArrayBuffer` in a `data` store keyed by `(ino, chunkIndex)`. `dirLookup` → index on `[parentIno, name]`. Enables a full filesystem in the browser.

---

## Summary

The entire design is two interfaces:

- **`StorageBackend`** (10 methods) — what you implement per storage medium.
- **`FileSystem`** (14 methods) — what tools consume, provided by the VFS.

The VFS layer between them handles Fd management, path resolution, permission checks, symlink traversal, link counting, and operation composition. Every shell command is a thin wrapper over the VFS. Every storage medium is a thin implementation of the backend.
