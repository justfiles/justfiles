import type { StorageBackend } from './storage';
import { FileType, OpenFlags } from './types';
import type { Ino, Stat, Off, DirCursor, Dirent, Fd } from './types';

/**
 * The consumer-facing filesystem interface.
 *
 * Design principles:
 * - Operates on inodes, not paths. Path resolution is a higher layer.
 * - Directory is just a mapping of name → ino, not a special concept.
 * - No convenience methods. rename = dirLookup + dirSet + dirUnset.
 *   ls = open + readdir.
 * - Fd-based I/O with explicit offsets (pread/pwrite style) to avoid
 *   hidden cursor state and enable safe concurrency.
 * - Batch readdir via cursor for performance (avoids 1 syscall per entry).
 * - Hard link reference counting (nlink) is entirely backend-internal.
 *   The VFS only adds and removes directory entries; the backend manages
 *   nlink as a side effect and frees inodes automatically.
 */
export interface FileSystem {

  // --- inode operations ---

  /** Stat an inode directly. */
  stat(ino: Ino): Promise<Stat>;

  /** Update mtime, mode, etc. Only set fields are applied. */
  setattr(ino: Ino, attrs: Partial<Pick<Stat, 'mode' | 'mtimeNs'>>): Promise<void>;

  /** Read a single extended attribute from an inode. */
  getXattr(ino: Ino, name: string): Promise<Uint8Array | null>;

  /** Write or replace a single extended attribute on an inode. */
  setXattr(ino: Ino, name: string, value: Uint8Array): Promise<void>;

  /** List all extended attribute names currently set on an inode. */
  listXattr(ino: Ino): Promise<string[]>;

  /** Remove a single extended attribute from an inode. */
  removeXattr(ino: Ino, name: string): Promise<void>;

  // --- directory operations ---

  /**
   * Look up a single name within a directory inode.
   * This is the primitive that path resolution calls repeatedly.
   * Returns null if not found (not an error — callers need to
   * distinguish "not found" from "I/O failure").
   */
  lookup(dirIno: Ino, name: string): Promise<Ino | null>;

  /**
   * Read directory entries in batches.
   * An empty-string cursor starts from the beginning. Returns next cursor
   * position (empty string means end). Batch size is up to the implementation.
   *
   * DirCursor is opaque — it is not a byte offset but a backend-defined
   * continuation token (stringified offset, B-tree key, DynamoDB token, etc.).
   */
  readdir(dirIno: Ino, cursor: DirCursor): Promise<{
    entries: Dirent[];
    next: DirCursor;
  }>;

  /**
   * Create a new inode and link it into a directory in one atomic op.
   * Returns the new inode number.
   *
   * Why combined: creating an orphan inode is almost never useful,
   * and splitting create + link invites race conditions.
   *
   * For regular files and directories only. Use symlink() for symlinks.
   */
  mknod(dirIno: Ino, name: string, type: FileType, mode: number): Promise<Ino>;

  /**
   * Create a symbolic link.
   * Separated from mknod because the symlink target is a required argument
   * that has no meaning for any other file type.
   */
  symlink(dirIno: Ino, name: string, target: string, mode?: number): Promise<Ino>;

  /**
   * Add a hard link: make name in dirIno point to an existing inode.
   * The VFS calls backend.dirAdd(dirIno, name, targetIno, type), which
   * atomically increments nlink inside the backend. dirAdd is no-clobber:
   * if name already exists the backend returns false and the VFS throws
   * EEXIST. One backend call, no crash window.
   * Directories cannot be hard-linked (would create cycles).
   */
  link(dirIno: Ino, name: string, targetIno: Ino): Promise<void>;

  /**
   * Remove a name from a directory.
   * The VFS calls backend.dirUnset(dirIno, name), which atomically
   * decrements nlink and frees the inode if it hits 0 — all inside the
   * backend. No separate free step is needed — one backend call, no crash
   * window, safe across concurrent VFS instances.
   * For directories: must be empty first.
   */
  unlink(dirIno: Ino, name: string): Promise<void>;

  // --- file I/O ---

  /**
   * Open an inode, returning a file descriptor.
   * The VFS checks its metadata cache before hitting the backend —
   * if stat(ino) was recently called, open() costs 0 backend round trips.
   * The Fd is the unit of I/O and the thing higher layers manage.
   */
  open(ino: Ino, flags: OpenFlags): Promise<Fd>;

  /**
   * Positional read — no hidden cursor, no seek.
   * Returns bytes read (may be less than length). 0 = EOF.
   *
   * Why pread over read+seek: eliminates hidden mutable state,
   * makes concurrent reads from the same Fd safe without locking.
   */
  pread(fd: Fd, buf: Uint8Array, offset: Off): Promise<number>;

  /**
   * Positional write. Returns bytes written.
   */
  pwrite(fd: Fd, buf: Uint8Array, offset: Off): Promise<number>;

  /**
   * Ensure written data is durable. Without this, writes may be buffered.
   */
  fsync(fd: Fd): Promise<void>;

  /**
   * Truncate or extend file to exactly size bytes.
   */
  truncate(fd: Fd, size: Off): Promise<void>;

  /** Release the file descriptor and associated resources. */
  close(fd: Fd): Promise<void>;

  // --- symlinks and rename ---

  /**
   * Move or rename a file or directory.
   *
   * If backend.rename?() is available the VFS delegates to it (atomic,
   * no consistency window).
   *
   * Otherwise the VFS synthesises rename as:
   *   dirLookup(oldDir, oldName)          → { ino, type }    [RTT 1]
   *   dirSet(newDir, newName, ino, type)  → displaced | null  [RTT 2]
   *   dirUnset(oldDir, oldName)                               [RTT 3]
   *
   * Because dirSet (overwrite) increments nlink on the incoming ino and
   * dirUnset decrements it, the net nlink change on the moved inode is
   * zero and the inode is never freed prematurely — even without rename?().
   * The only downside of the fallback is a window where both names exist
   * simultaneously. rename?() closes that window.
   *
   * If newName existed and was displaced, dirSet returns the displaced
   * entry; the backend already freed it if nlink hit 0. The VFS evicts
   * the displaced ino from its cache. No separate linkDec call is needed.
   */
  rename(oldDirIno: Ino, oldName: string, newDirIno: Ino, newName: string): Promise<void>;

  /** Read the target of a symlink inode. */
  readlink(ino: Ino): Promise<string>;

  // --- filesystem-level ---

  /** Get root inode. Typically 1n or 2n. Entry point for all path resolution. */
  root(): Ino;

  /**
   * Walk the entire filesystem tree, calling visitor once per node.
   *
   * Uses storage.scan() when available — O(pages) round trips for cloud
   * backends. Falls back to recursive readdir — O(directories) round trips.
   *
   * Visitor receives a VFS-rooted path ("/foo/bar"), the inode number, and
   * its stat. Directories are visited before their contents.
   */
  scan(visitor: (path: string, ino: Ino, stat: Stat) => Promise<void>): Promise<void>;
}

export function fs(storage: StorageBackend): FileSystem {
	type InodeMeta = NonNullable<Awaited<ReturnType<StorageBackend['getMeta']>>>
	type FdEntry = {
		ino: Ino
		flags: OpenFlags
	}

	const metaCache = new Map<Ino, InodeMeta>()
	const dirCache = new Map<string, Ino | null>()
	const contentCache = new Map<Ino, Uint8Array>()
	const fdTable = new Map<Fd, FdEntry>()
	let nextFd = 1

	function nowNs(): bigint {
		return BigInt(Date.now()) * 1_000_000n
	}

	function dirCacheKey(dirIno: Ino, name: string): string {
		return `${dirIno}:${name}`
	}

	function invalidateDirCache(dirIno: Ino): void {
		const prefix = `${dirIno}:`
		for (const key of dirCache.keys()) {
			if (key.startsWith(prefix)) {
				dirCache.delete(key)
			}
		}
	}

	function invalidateIno(ino: Ino): void {
		metaCache.delete(ino)
		contentCache.delete(ino)
	}

	function makeStat(ino: Ino, meta: InodeMeta): Stat {
		return {
			ino,
			type: meta.type,
			size: meta.size,
			mode: meta.mode,
			nlink: meta.nlink,
			mtimeNs: meta.mtimeNs,
			ctimeNs: meta.ctimeNs,
			contentHash: meta.contentHash,
		}
	}

	async function getMetaOrThrow(ino: Ino): Promise<InodeMeta> {
		const cached = metaCache.get(ino)
		if (cached) return cached

		const meta = await storage.getMeta(ino)
		if (meta === null) {
			throw new Error(`ENOENT: inode ${ino}`)
		}

		metaCache.set(ino, meta)
		return meta
	}

	function getFdOrThrow(fd: Fd): FdEntry {
		const entry = fdTable.get(fd)
		if (!entry) {
			throw new Error(`EBADF: fd ${fd}`)
		}
		return entry
	}

	function ensureReadable(fd: FdEntry): void {
		if ((fd.flags & OpenFlags.Read) === 0) {
			throw new Error('EBADF: fd is not open for reading')
		}
	}

	function ensureWritable(fd: FdEntry): void {
		if ((fd.flags & OpenFlags.Write) === 0) {
			throw new Error('EBADF: fd is not open for writing')
		}
	}

	async function createNode(dirIno: Ino, name: string, meta: Omit<InodeMeta, 'nlink'>): Promise<Ino> {
		if (storage.create) {
			const ino = await storage.create(dirIno, name, meta)
			invalidateDirCache(dirIno)
			return ino
		}

		const ino = await storage.alloc(meta)
		const added = await storage.dirAdd(dirIno, name, ino, meta.type)
		if (!added) {
			// The backend interface has no reclaim primitive, so alloc()+dirAdd()
			// can still orphan an inode here. Backends should implement create()
			// to make this path atomic.
			throw new Error(`EEXIST: ${name}`)
		}

		invalidateDirCache(dirIno)
		return ino
	}

	const vfs: FileSystem = {
		async stat(ino: Ino): Promise<Stat> {
			return makeStat(ino, await getMetaOrThrow(ino))
		},

		async setattr(ino: Ino, attrs: Partial<Pick<Stat, 'mode' | 'mtimeNs'>>): Promise<void> {
			await storage.setMeta(ino, attrs)
			metaCache.delete(ino)
		},

		async getXattr(ino: Ino, name: string): Promise<Uint8Array | null> {
			if (!storage.getXattr) {
				return null
			}
			return storage.getXattr(ino, name)
		},

		async setXattr(ino: Ino, name: string, value: Uint8Array): Promise<void> {
			await storage.setXattr?.(ino, name, value)
		},

		async listXattr(ino: Ino): Promise<string[]> {
			if (!storage.listXattr) {
				return []
			}
			return storage.listXattr(ino)
		},

		async removeXattr(ino: Ino, name: string): Promise<void> {
			await storage.removeXattr?.(ino, name)
		},

		async lookup(dirIno: Ino, name: string): Promise<Ino | null> {
			const key = dirCacheKey(dirIno, name)
			if (dirCache.has(key)) {
				return dirCache.get(key) ?? null
			}

			const entry = await storage.dirLookup(dirIno, name)
			const ino = entry?.ino ?? null
			dirCache.set(key, ino)
			return ino
		},

		async readdir(dirIno: Ino, cursor: DirCursor): Promise<{ entries: Dirent[]; next: DirCursor }> {
			const batch = await storage.dirList(dirIno, cursor)
			return {
				entries: batch.entries.map((entry) => ({
					ino: entry.ino,
					name: entry.name,
					type: entry.type,
				})),
				next: batch.next,
			}
		},

		async mknod(dirIno: Ino, name: string, type: FileType, mode: number): Promise<Ino> {
			return createNode(dirIno, name, {
				type,
				size: 0n,
				mode,
				mtimeNs: nowNs(),
				ctimeNs: nowNs(),
			})
		},

		async symlink(dirIno: Ino, name: string, target: string, mode = 0o777): Promise<Ino> {
			return createNode(dirIno, name, {
				type: FileType.Symlink,
				size: BigInt(new TextEncoder().encode(target).length),
				mode,
				mtimeNs: nowNs(),
				ctimeNs: nowNs(),
				symlinkTarget: target,
			})
		},

		async link(dirIno: Ino, name: string, targetIno: Ino): Promise<void> {
			const target = await getMetaOrThrow(targetIno)
			if (target.type === FileType.Directory) {
				throw new Error('EPERM: cannot hard-link a directory')
			}

			const added = await storage.dirAdd(dirIno, name, targetIno, target.type)
			if (!added) {
				throw new Error(`EEXIST: ${name}`)
			}

			invalidateDirCache(dirIno)
			invalidateIno(targetIno)
		},

		async unlink(dirIno: Ino, name: string): Promise<void> {
			const removed = await storage.dirUnset(dirIno, name)
			if (removed === null) {
				throw new Error(`ENOENT: ${name}`)
			}

			invalidateDirCache(dirIno)
			invalidateIno(removed.ino)
		},

		async open(ino: Ino, flags: OpenFlags): Promise<Fd> {
			await getMetaOrThrow(ino)

			if ((flags & OpenFlags.Write) !== 0 && (flags & OpenFlags.Trunc) !== 0) {
				await storage.truncate(ino, 0n)
				contentCache.delete(ino)

				const meta = metaCache.get(ino)
				if (meta) {
					metaCache.set(ino, { ...meta, size: 0n })
				}
			}

			const fd = nextFd
			nextFd += 1
			fdTable.set(fd, { ino, flags })
			return fd
		},

		async pread(fd: Fd, buf: Uint8Array, offset: Off): Promise<number> {
			const entry = getFdOrThrow(fd)
			ensureReadable(entry)
			const { ino } = entry
			const meta = await getMetaOrThrow(ino)

			let content = contentCache.get(ino)
			if (!content) {
				if (meta.size === 0n) {
					content = new Uint8Array()
				} else {
					content = await storage.read(ino, 0n, Number(meta.size))
				}
				contentCache.set(ino, content)
			}

			const start = Number(offset)
			if (start >= content.length) {
				return 0
			}

			const end = Math.min(start + buf.length, content.length)
			const chunk = content.subarray(start, end)
			buf.set(chunk, 0)
			return chunk.length
		},

		async pwrite(fd: Fd, buf: Uint8Array, offset: Off): Promise<number> {
			const entry = getFdOrThrow(fd)
			ensureWritable(entry)
			const { ino } = entry
			const written = await storage.write(ino, offset, buf)
			invalidateIno(ino)
			return written
		},

		async fsync(fd: Fd): Promise<void> {
			getFdOrThrow(fd)
		},

		async truncate(fd: Fd, size: Off): Promise<void> {
			const entry = getFdOrThrow(fd)
			ensureWritable(entry)
			const { ino } = entry
			await storage.truncate(ino, size)
			invalidateIno(ino)
		},

		async close(fd: Fd): Promise<void> {
			fdTable.delete(fd)
		},

		async rename(oldDirIno: Ino, oldName: string, newDirIno: Ino, newName: string): Promise<void> {
			if (storage.rename) {
				const displaced = await storage.rename(oldDirIno, oldName, newDirIno, newName)
				invalidateDirCache(oldDirIno)
				invalidateDirCache(newDirIno)
				if (displaced !== null) {
					invalidateIno(displaced)
				}
				return
			}

			const source = await storage.dirLookup(oldDirIno, oldName)
			if (source === null) {
				throw new Error(`ENOENT: ${oldName}`)
			}

			const displaced = await storage.dirSet(newDirIno, newName, source.ino, source.type)
			await storage.dirUnset(oldDirIno, oldName)

			invalidateDirCache(oldDirIno)
			invalidateDirCache(newDirIno)
			if (displaced !== null) {
				invalidateIno(displaced.ino)
			}
		},

		async readlink(ino: Ino): Promise<string> {
			const meta = await getMetaOrThrow(ino)
			if (meta.type !== FileType.Symlink || meta.symlinkTarget === undefined) {
				throw new Error(`EINVAL: inode ${ino} is not a symlink`)
			}
			return meta.symlinkTarget
		},

		root(): Ino {
			return storage.rootIno
		},

		async scan(visitor: (path: string, ino: Ino, stat: Stat) => Promise<void>): Promise<void> {
			if (storage.scan) {
				const inoToPath = new Map<Ino, string>([[vfs.root(), '/']])
				let cursor = ''
				do {
					const { entries, next } = await storage.scan(cursor)
					for (const e of entries) {
						const dir = inoToPath.get(e.dirIno) ?? '/'
						const path = dir === '/' ? `/${e.name}` : `${dir}/${e.name}`
						inoToPath.set(e.ino, path)
						await visitor(path, e.ino, makeStat(e.ino, e.meta))
					}
					cursor = next
				} while (cursor !== '')
			} else {
				async function walk(dirIno: Ino, dirPath: string): Promise<void> {
					let cursor = ''
					do {
						const { entries, next } = await storage.dirList(dirIno, cursor)
						for (const e of entries) {
							const path = dirPath === '/' ? `/${e.name}` : `${dirPath}/${e.name}`
							const meta = await storage.getMeta(e.ino)
							if (meta === null) continue
							await visitor(path, e.ino, makeStat(e.ino, meta))
							if (e.type === FileType.Directory) await walk(e.ino, path)
						}
						cursor = next
					} while (cursor !== '')
				}
				await walk(vfs.root(), '/')
			}
		},
	}
	return vfs
}
