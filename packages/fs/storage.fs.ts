import type { Stats } from 'node:fs'
import {
	lstat as _lstat,
	rename as _rename,
	symlink as _symlink,
	chmod,
	lutimes,
	mkdir,
	open,
	readdir,
	readFile,
	rmdir,
	unlink,
	writeFile
} from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { InodeMeta, Storage, StorageCapabilities, StorageChange } from './storage'
import type { Ino } from './types'
import { FileType } from './types'

// Pin lstat to the non-bigint overload so Stats fields are number, not number|bigint
const lstat = (path: string): Promise<Stats> => _lstat(path) as Promise<Stats>

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
	// come back absolute either way.
	function volPath(osPath: string): string {
		const rel = relative(root, osPath)
		return rel === '' ? '/' : `/${rel}`
	}

	function toFileType(s: Stats): FileType {
		if (s.isDirectory()) return FileType.Directory
		if (s.isSymbolicLink()) return FileType.Symlink
		return FileType.Regular
	}

	function metaFromStats(s: Stats): InodeMeta {
		return {
			type: toFileType(s),
			size: BigInt(s.size),
			mode: s.mode & 0o7777,
			mtimeNs: BigInt(Math.trunc(s.mtimeMs)) * 1_000_000n,
			ctimeNs: BigInt(Math.trunc(s.ctimeMs)) * 1_000_000n
		}
	}

	const caps: StorageCapabilities = {
		async atomicCreate(dirIno, name, meta, options) {
			const childPath = join(getPath(dirIno), name)
			if (meta.type === FileType.Directory) {
				await mkdir(childPath, { mode: meta.mode })
			} else if (meta.type === FileType.Symlink) {
				await _symlink(meta.symlinkTarget ?? '', childPath)
			} else {
				const fh = await open(childPath, 'wx', meta.mode)
				await fh.close()
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
				return metaFromStats(await lstat(getPath(ino)))
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
			await writeFile(getPath(ino), data)
			emit({ ino, kind: 'content', source: options?.source })
		},

		async getDirent(dirIno, name) {
			const childPath = join(getPath(dirIno), name)
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
			const names = (await readdir(dirPath)).sort()
			const start = cursor === '' ? 0 : names.findIndex((n) => n > cursor)
			const slice = start === -1 ? [] : names.slice(start)

			const entries = await Promise.all(
				slice.map(async (name) => {
					const childPath = join(dirPath, name)
					const s = await lstat(childPath)
					const ino = String(s.ino)
					pathMap.set(ino, childPath)
					return { name, ino, type: toFileType(s) }
				})
			)

			return { entries, next: '' }
		}
	}
}
