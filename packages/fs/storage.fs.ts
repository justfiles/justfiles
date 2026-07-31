import type { Stats } from 'node:fs'
import {
	lstat as _lstat,
	rename as _rename,
	symlink as _symlink,
	chmod,
	link,
	lutimes,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	rmdir,
	unlink
} from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { InodeMeta, Storage, StorageCapabilities, StorageChange } from './storage'
import type { Ino } from './types'
import { FileType } from './types'

// Pin lstat to the non-bigint overload so Stats fields are number, not number|bigint
const lstat = (path: string): Promise<Stats> => _lstat(path) as Promise<Stats>

/**
 * Write `data` under a private sibling name, then take `name` in ONE operation.
 *
 * POSIX has no atomic content write. `open(O_CREAT|O_EXCL)` publishes an EMPTY name
 * and `write()` fills it afterwards, so a concurrent reader can resolve the name and
 * read nothing — or, past Node's write chunk, a prefix. Every system that needs this
 * guarantee answers it the same way: put the payload somewhere uncontested, publish
 * the name last. Maildir writes into `tmp/` and renames into `new/`; git writes a
 * loose object to a temp file and links it to its sha1 name; dpkg uses `.dpkg-tmp`;
 * RocksDB writes the SSTable and only then flips MANIFEST.
 *
 * `link`, not `rename`, and both halves of why are load-bearing. `link` is the only
 * POSIX call that is BOTH atomic AND no-replace. Atomic is the point. No-replace is
 * what makes the `EEXIST` of a lost race (or of an already-occupied name) come from
 * the publish ITSELF rather than from a check before it — and a check before it is
 * exactly the TOCTOU this closes.
 *
 * The temp file is a SIBLING of the target, not a file in one shared temp directory:
 * `link(2)` cannot cross a filesystem, and a volume root can have another mount
 * underneath it. A sibling is on the target's own filesystem by construction.
 *
 * This is a hard link, so the inode carries two names between `link` and `unlink`.
 * `Storage` already permits exactly that shape transiently (see the interface note on
 * rename/move), and `inflight` hides the second one from this instance's read paths.
 */
async function publish(
	inflight: Set<string>,
	dir: string,
	name: string,
	data: Uint8Array,
	mode: number
): Promise<void> {
	const tmp = join(dir, `.jfs-publish-${crypto.randomUUID()}`)
	inflight.add(tmp)
	try {
		const fh = await open(tmp, 'wx', mode)
		try {
			// `writeFile` on the handle, not `write`: the full-buffer API loops, so a short
			// write cannot publish a prefix. This is the whole reason the payload goes here
			// first — it can take as many syscalls as it likes under a name nobody reads.
			await fh.writeFile(data)
		} finally {
			await fh.close()
		}
		await link(tmp, join(dir, name))
	} finally {
		// Covers the WHOLE lifecycle, not just the link: a write or close that fails
		// (ENOSPC, EIO) would otherwise strand the temp file, and repeated failures would
		// quietly consume the disk. Swallowed because there may be nothing to remove —
		// `open` itself can be what failed.
		await unlink(tmp).catch(() => {})
		inflight.delete(tmp)
	}
}

/**
 * A Storage backed directly by the local filesystem.
 *
 * Ino = OS inode number (stat.ino, stringified). The pathMap bridges the
 * inode-based Storage interface to Node's path-based APIs. It is
 * populated lazily — every Ino handed to a caller was obtained via
 * getDirent/listDirents/atomicCreate in the same session, which already
 * inserted the path.
 *
 * No caching: the OS page cache and dentry cache handle that.
 */
export async function nativeStorage(root: string): Promise<Storage> {
	const pathMap = new Map<Ino, string>()

	/**
	 * Temp files this instance is publishing RIGHT NOW, by absolute OS path. The read
	 * paths below hide exactly these, and nothing else.
	 *
	 * NOT a reserved filename prefix. Hiding every name matching a pattern destroys a
	 * user's own file called `.jfs-publish-notes.md`: the create SUCCEEDS and the file is
	 * then unreadable, unlistable and undeletable through the volume — a write that
	 * reports success and vanishes, which is the worst failure in this file. Scoping the
	 * hiding to publishes actually in flight costs nothing and cannot do that.
	 *
	 * The flip side is deliberate: a temp file orphaned by a crash is NOT hidden. It is
	 * an ordinary file holding partial content, which is the honest thing for it to be —
	 * visible means a user or a sweep can delete it, hidden would mean nothing ever
	 * could. dpkg's `.dpkg-tmp` and git's `tmp_obj_*` are visible for the same reason. A
	 * scan from ANOTHER process can likewise still catch one mid-publish; that window is
	 * short, and replicating a file that then vanishes is recoverable in a way that
	 * eating a note is not.
	 */
	const inflight = new Set<string>()

	const rootStat = await lstat(root)
	const rootIno = String(rootStat.ino)
	pathMap.set(rootIno, root)

	const listeners = new Set<(change: StorageChange) => void>()
	function emit(change: StorageChange): void {
		if (listeners.size === 0) return
		for (const fn of [...listeners]) fn(change)
	}

	function getPath(ino: Ino): string {
		const p = pathMap.get(ino)
		if (p === undefined) throw new Error(`ESTALE: unknown inode ${ino}`)
		return p
	}

	// OS path -> the volume-relative path a `StorageChange` reports (`/a/b`).
	// Derived with `relative`, not by slicing `root.length`: the root is whatever the
	// caller spelled (a CLI-configured '~/notes/', or '/'), and a volume path must
	// come back absolute either way. Volume paths are '/'-separated wherever the OS
	// path is not — listeners compare them on '/' boundaries.
	function volPath(osPath: string): string {
		const rel = relative(root, osPath)
		return rel === '' ? '/' : `/${rel.split(sep).join('/')}`
	}

	function toFileType(s: Stats): FileType {
		if (s.isDirectory()) return FileType.Directory
		if (s.isSymbolicLink()) return FileType.Symlink
		return FileType.Regular
	}

	async function metaFromStats(s: Stats, path: string): Promise<InodeMeta> {
		return {
			type: toFileType(s),
			size: BigInt(s.size),
			mode: s.mode & 0o7777,
			mtimeNs: BigInt(Math.trunc(s.mtimeMs)) * 1_000_000n,
			ctimeNs: BigInt(Math.trunc(s.ctimeMs)) * 1_000_000n,
			...(s.isSymbolicLink() ? { symlinkTarget: await readlink(path) } : {})
		}
	}

	const caps: StorageCapabilities = {
		async atomicCreate(dirIno, name, meta, content, options) {
			const dirPath = getPath(dirIno)
			const childPath = join(dirPath, name)
			if (meta.type === FileType.Directory) {
				await mkdir(childPath, { mode: meta.mode })
			} else if (meta.type === FileType.Symlink) {
				await _symlink(meta.symlinkTarget ?? '', childPath)
			} else if (content === undefined) {
				// No content to publish, so the name is the whole claim (`O_EXCL`).
				const fh = await open(childPath, 'wx', meta.mode)
				await fh.close()
			} else {
				// This backend has no hash-addressed content store, so the bytes are handed
				// to it directly and the name must not appear until they are all there.
				await publish(inflight, dirPath, name, content, meta.mode)
			}
			const s = await lstat(childPath)
			const ino = String(s.ino)
			pathMap.set(ino, childPath)
			emit({ ino, kind: 'meta', source: options?.source })
			emit({ ino, kind: 'dirent', dirIno, name, path: volPath(childPath), source: options?.source })
			return ino
		},

		async atomicMove(oldDir, oldName, newDir, newName, options) {
			const oldPath = join(getPath(oldDir), oldName)
			const newPath = join(getPath(newDir), newName)

			const srcIno = String((await lstat(oldPath)).ino)
			let displaced: Ino | null = null
			try {
				const d = String((await lstat(newPath)).ino)
				if (d !== srcIno) displaced = d
			} catch {}

			await _rename(oldPath, newPath)

			// Update pathMap for the moved entry and all cached descendants
			const oldPrefix = `${oldPath}/`
			for (const [ino, p] of pathMap) {
				if (p === oldPath) pathMap.set(ino, newPath)
				else if (p.startsWith(oldPrefix))
					pathMap.set(ino, `${newPath}/${p.slice(oldPrefix.length)}`)
			}
			if (displaced !== null) pathMap.delete(displaced)

			if (displaced !== null) emit({ ino: displaced, kind: 'meta', source: options?.source })
			emit({
				ino: srcIno,
				kind: 'dirent',
				dirIno: newDir,
				name: newName,
				path: volPath(newPath),
				source: options?.source
			})
			emit({
				ino: srcIno,
				kind: 'dirent',
				dirIno: oldDir,
				name: oldName,
				path: volPath(oldPath),
				source: options?.source
			})
			return displaced
		},

		subscribe(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		}
	}

	return {
		rootIno,
		caps,

		async getMeta(ino) {
			try {
				const path = getPath(ino)
				return await metaFromStats(await lstat(path), path)
			} catch {
				return null
			}
		},

		async setMeta(ino, patch, options) {
			const path = getPath(ino)
			if (patch.mode !== undefined) await chmod(path, patch.mode)
			if (patch.mtimeNs !== undefined) {
				const t = new Date(Number(patch.mtimeNs / 1_000_000n))
				await lutimes(path, t, t)
			}
			emit({ ino, kind: 'meta', source: options?.source })
		},

		async deleteInode(ino) {
			const path = pathMap.get(ino)
			if (!path) return
			pathMap.delete(ino)
			const prefix = path.endsWith('/') ? path : `${path}/`
			for (const [childIno, childPath] of pathMap) {
				if (childPath.startsWith(prefix)) {
					pathMap.delete(childIno)
				}
			}
			emit({ ino, kind: 'meta' })
		},

		async getBlob(ino) {
			const buf = await readFile(getPath(ino))
			return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
		},

		async putBlob(ino, data, options) {
			// `r+`, never `w`: the OS resolves the path and hands back a handle to the file
			// that is THERE, so a note deleted since it was resolved fails ENOENT instead of
			// being written back into existence.
			const handle = await open(getPath(ino), 'r+')
			try {
				// …but a PATH is not an identity. Unlink-and-recreate (what a sync client, an
				// editor's atomic save, or `rm` + touch does) leaves the name pointing at a
				// different inode, and this handle would then truncate a stranger's file and
				// report success. The handle knows what it opened, so ask it: content is
				// addressed by inode here, and only the inode we were given may be written.
				if (String((await handle.stat()).ino) !== ino) throw new Error(`ENOENT: ino ${ino}`)
				await handle.truncate(0)
				// `writeFile` on the handle, not `write`: a short write leaves the file holding
				// a prefix of the note while we report success. The full-buffer API loops.
				await handle.writeFile(data)
				// …and asked again afterwards, because the check above only covers a swap that
				// had ALREADY happened. A replace that lands mid-write leaves this handle
				// writing an inode nothing can reach any more, and reporting success would tell
				// the caller its note is saved when the name it saved under holds someone
				// else's. There is no POSIX way to hold a name still, so the honest answer is
				// to notice and fail: a reported failure is recoverable, a false success is not.
				if (String((await lstat(getPath(ino))).ino) !== ino) {
					throw new Error(`ENOENT: ino ${ino} was replaced while it was being written`)
				}
			} finally {
				await handle.close()
			}
			emit({ ino, kind: 'content', source: options?.source })
		},

		async getDirent(dirIno, name) {
			const childPath = join(getPath(dirIno), name)
			if (inflight.has(childPath)) return null // a publish in flight is not addressable
			try {
				const s = await lstat(childPath)
				const ino = String(s.ino)
				pathMap.set(ino, childPath)
				return { ino, type: toFileType(s) }
			} catch {
				return null
			}
		},

		async putDirent(dirIno, name, { ino }, options) {
			const srcPath = getPath(ino)
			const dstPath = join(getPath(dirIno), name)
			await _rename(srcPath, dstPath)
			pathMap.set(ino, dstPath)
			emit({ ino, kind: 'dirent', dirIno, name, path: volPath(dstPath), source: options?.source })
		},

		async deleteDirent(dirIno, name, options) {
			const childPath = join(getPath(dirIno), name)
			const s = await lstat(childPath)
			const ino = String(s.ino)
			if (s.isDirectory()) await rmdir(childPath)
			else await unlink(childPath)
			emit({ ino, kind: 'dirent', dirIno, name, path: volPath(childPath), source: options?.source })
		},

		async listDirents(dirIno, cursor) {
			const dirPath = getPath(dirIno)
			// Filtered BEFORE the cursor slice, so a hidden name can never be handed out as
			// a cursor position a later page resumes from.
			const names = (await readdir(dirPath)).filter((n) => !inflight.has(join(dirPath, n))).sort()
			const start = cursor === '' ? 0 : names.findIndex((n) => n > cursor)
			const slice = start === -1 ? [] : names.slice(start)

			const entries = (
				await Promise.all(
					slice.map(async (name) => {
						const childPath = join(dirPath, name)
						// `readdir` gives NAMES; each one then needs its own `lstat`. A name that
						// vanished in between is simply NOT IN the listing — it is not a listing
						// FAILURE. POSIX promises nothing about an entry removed during iteration,
						// and rejecting means any concurrent `rm` (or a publish temp finishing
						// between the filter above and here) blows up an unrelated `readdir`.
						//
						// ENOENT only, not any failure: EACCES or EIO on an entry that IS there is a
						// real fault, and silently dropping it would report a listing that is short
						// by a file nobody can see is missing.
						let s: Stats
						try {
							s = await lstat(childPath)
						} catch (e) {
							if ((e as { code?: string }).code !== 'ENOENT') throw e
							return null
						}
						const ino = String(s.ino)
						pathMap.set(ino, childPath)
						return { name, ino, type: toFileType(s) }
					})
				)
			).filter((e) => e !== null)

			return { entries, next: '' }
		}
	}
}
