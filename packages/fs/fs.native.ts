import { lstat as _lstat, mkdir, open, symlink, link, unlink, rmdir, rename, readlink, chmod, lutimes, readdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { constants, type Stats } from 'node:fs'
import { join } from 'node:path'
import type { FileSystem } from './fs'
import { FileType, OpenFlags } from './types'
import type { Ino, Stat, Off, DirCursor, Dirent, Fd } from './types'

// Pin lstat to the non-bigint overload so Stats fields are number, not number|bigint
const lstat = (path: string): Promise<Stats> => _lstat(path) as Promise<Stats>

/**
 * A FileSystem implementation backed directly by the local filesystem.
 *
 * Ino = real OS inode number (stat.ino as bigint). The pathMap bridges
 * the inode-based FileSystem interface to Node's path-based APIs.
 * It is populated lazily — every Ino handed to a caller was obtained via
 * lookup/mknod/readdir in the same session, which already inserted the path.
 *
 * No VFS caching layer: the OS page cache and dentry cache handle that.
 */
export async function nativeFs(root: string): Promise<FileSystem> {
	const pathMap = new Map<Ino, string>()
	const handles = new Map<Fd, { fh: FileHandle; flags: OpenFlags }>()

	const rootStat = await lstat(root)
	const rootIno = String(rootStat.ino)
	pathMap.set(rootIno, root)

	function getPath(ino: Ino): string {
		const p = pathMap.get(ino)
		if (p === undefined) throw new Error(`ESTALE: unknown inode ${ino}`)
		return p
	}

	function getHandle(fd: Fd): { fh: FileHandle; flags: OpenFlags } {
		const entry = handles.get(fd)
		if (!entry) throw new Error(`EBADF: fd ${fd}`)
		return entry
	}

	function toFileType(s: Stats): FileType {
		if (s.isDirectory()) return FileType.Directory
		if (s.isSymbolicLink()) return FileType.Symlink
		return FileType.Regular
	}

	function toStat(ino: Ino, s: Stats): Stat {
		return {
			ino,
			type: toFileType(s),
			size: BigInt(s.size),
			mode: s.mode & 0o7777,
			nlink: s.nlink,
			mtimeNs: BigInt(Math.trunc(s.mtimeMs)) * 1_000_000n,
			ctimeNs: BigInt(Math.trunc(s.ctimeMs)) * 1_000_000n,
		}
	}

	// Reject names that would escape the directory (empty, . , .. , embedded slash)
	function validateName(name: string): void {
		if (name === '' || name === '.' || name === '..' || name.includes('/')) {
			throw new Error(`EINVAL: invalid name "${name}"`)
		}
	}

	function toNodeFlags(flags: OpenFlags): string | number {
		const r = (flags & OpenFlags.Read) !== 0
		const w = (flags & OpenFlags.Write) !== 0
		const t = (flags & OpenFlags.Trunc) !== 0
		if (r && w && t) return 'w+'
		if (r && w) return 'r+'
		if (w && t) return 'w'
		// O_WRONLY: write-only without truncation. No string shorthand in Node.js.
		if (w) return constants.O_WRONLY
		return 'r'
	}

	return {
		root(): Ino {
			return rootIno
		},

		async stat(ino: Ino): Promise<Stat> {
			return toStat(ino, await lstat(getPath(ino)))
		},

		async setattr(ino: Ino, attrs: Partial<Pick<Stat, 'mode' | 'mtimeNs'>>): Promise<void> {
			const path = getPath(ino)
			if (attrs.mode !== undefined) {
				await chmod(path, attrs.mode)
			}
			if (attrs.mtimeNs !== undefined) {
				const t = new Date(Number(attrs.mtimeNs / 1_000_000n))
				await lutimes(path, t, t)
			}
		},

		async lookup(dirIno: Ino, name: string): Promise<Ino | null> {
			validateName(name)
			const childPath = join(getPath(dirIno), name)
			try {
				const s = await lstat(childPath)
				const ino = String(s.ino)
				pathMap.set(ino, childPath)
				return ino
			} catch (e: any) {
				if (e.code === 'ENOENT') return null
				throw e
			}
		},

		async readdir(dirIno: Ino, cursor: DirCursor): Promise<{ entries: Dirent[]; next: DirCursor }> {
			const dirPath = getPath(dirIno)
			const names = (await readdir(dirPath)).sort()
			const start = cursor === '' ? 0 : names.findIndex(n => n > cursor)
			const slice = start === -1 ? [] : names.slice(start)

			const entries: Dirent[] = []
			for (const name of slice) {
				const childPath = join(dirPath, name)
				const s = await lstat(childPath)
				const ino = String(s.ino)
				pathMap.set(ino, childPath)
				entries.push({ ino, name, type: toFileType(s) })
			}

			return { entries, next: '' }
		},

		async mknod(dirIno: Ino, name: string, type: FileType, mode: number): Promise<Ino> {
			validateName(name)
			// Issue 4: symlinks require a target; callers must use symlink() instead
			if (type === FileType.Symlink) throw new Error('EINVAL: use symlink() to create symlinks')
			const childPath = join(getPath(dirIno), name)
			if (type === FileType.Directory) {
				await mkdir(childPath, { mode })
			} else {
				const fh = await open(childPath, 'wx', mode)
				await fh.close()
			}
			const s = await lstat(childPath)
			const ino = String(s.ino)
			pathMap.set(ino, childPath)
			return ino
		},

		async symlink(dirIno: Ino, name: string, target: string): Promise<Ino> {
			validateName(name)
			const childPath = join(getPath(dirIno), name)
			await symlink(target, childPath)
			const s = await lstat(childPath)
			const ino = String(s.ino)
			pathMap.set(ino, childPath)
			return ino
		},

		async link(dirIno: Ino, name: string, targetIno: Ino): Promise<void> {
			validateName(name)
			const newPath = join(getPath(dirIno), name)
			await link(getPath(targetIno), newPath)
			// Point pathMap at the new link so unlink of the old path doesn't evict the ino.
			pathMap.set(targetIno, newPath)
		},

		async unlink(dirIno: Ino, name: string): Promise<void> {
			validateName(name)
			const childPath = join(getPath(dirIno), name)
			const s = await lstat(childPath)
			const childIno = String(s.ino)
			if (s.isDirectory()) {
				await rmdir(childPath)
			} else {
				await unlink(childPath)
			}
			// Issue 3: only evict if our cached path is the one we just removed.
			// If pathMap holds a different (surviving) hard-link path for this ino, keep it.
			if (pathMap.get(childIno) === childPath) pathMap.delete(childIno)
		},

		async open(ino: Ino, flags: OpenFlags): Promise<Fd> {
			const fh = await open(getPath(ino), toNodeFlags(flags))
			handles.set(fh.fd, { fh, flags })
			return fh.fd
		},

		async pread(fd: Fd, buf: Uint8Array, offset: Off): Promise<number> {
			const { fh, flags } = getHandle(fd)
			if ((flags & OpenFlags.Read) === 0) throw new Error(`EBADF: fd ${fd} not open for reading`)
			const { bytesRead } = await fh.read(buf, 0, buf.length, Number(offset))
			return bytesRead
		},

		async pwrite(fd: Fd, buf: Uint8Array, offset: Off): Promise<number> {
			const { bytesWritten } = await getHandle(fd).fh.write(buf, 0, buf.length, Number(offset))
			return bytesWritten
		},

		async fsync(fd: Fd): Promise<void> {
			await getHandle(fd).fh.sync()
		},

		async truncate(fd: Fd, size: Off): Promise<void> {
			await getHandle(fd).fh.truncate(Number(size))
		},

		async close(fd: Fd): Promise<void> {
			const { fh } = getHandle(fd)
			handles.delete(fd)
			await fh.close()
		},

		async rename(oldDirIno: Ino, oldName: string, newDirIno: Ino, newName: string): Promise<void> {
			validateName(oldName)
			validateName(newName)
			const oldPath = join(getPath(oldDirIno), oldName)
			const newPath = join(getPath(newDirIno), newName)

			// Capture srcIno and displaced ino before the rename changes the filesystem.
			const srcIno = String((await lstat(oldPath)).ino)
			let displacedIno: Ino | null = null
			try {
				const d = String((await lstat(newPath)).ino)
				// Don't treat as displaced if it's the same inode (rename onto own hard link / no-op).
				if (d !== srcIno) displacedIno = d
			} catch {}

			await rename(oldPath, newPath)

			// Update pathMap for the moved entry AND all cached descendants.
			// A rename of a directory invalidates every cached path under the old prefix.
			const oldPrefix = oldPath + '/'
			for (const [ino, p] of pathMap) {
				if (p === oldPath) {
					pathMap.set(ino, newPath)
				} else if (p.startsWith(oldPrefix)) {
					pathMap.set(ino, newPath + '/' + p.slice(oldPrefix.length))
				}
			}
			if (displacedIno !== null) pathMap.delete(displacedIno)
		},

		async readlink(ino: Ino): Promise<string> {
			return readlink(getPath(ino))
		},

		async scan(visitor: (path: string, ino: Ino, stat: Stat) => Promise<void>): Promise<void> {
			async function walk(osDir: string, vfsDir: string): Promise<void> {
				const names = (await readdir(osDir)).sort()
				for (const name of names) {
					const osPath = join(osDir, name)
					const s = await lstat(osPath)
					const ino = String(s.ino)
					pathMap.set(ino, osPath)
					const vfsPath = vfsDir === '/' ? `/${name}` : `${vfsDir}/${name}`
					await visitor(vfsPath, ino, toStat(ino, s))
					if (s.isDirectory()) await walk(osPath, vfsPath)
				}
			}
			await walk(root, '/')
		},
	}
}
