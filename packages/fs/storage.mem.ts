import type { InodeMeta, Storage, StorageCapabilities, StorageChange } from './storage'
import type { DirentMin, Ino } from './types'
import { FileType } from './types'

export function memStorage(): Storage {
	const metas = new Map<Ino, InodeMeta>()
	const blobs = new Map<Ino, Uint8Array>()
	const dirs = new Map<string, DirentMin>() // key: `${dirIno}\0${name}`
	const xattrs = new Map<Ino, Map<string, Uint8Array>>()
	const rootIno = '1'

	const listeners = new Set<(change: StorageChange) => void>()
	function emit(change: StorageChange): void {
		if (listeners.size === 0) return
		for (const fn of [...listeners]) fn(change)
	}

	metas.set(rootIno, {
		type: FileType.Directory,
		size: 0n,
		mode: 0o755,
		mtimeNs: 0n,
		ctimeNs: 0n
	})

	function dirKey(dirIno: Ino, name: string): string {
		return `${dirIno}\0${name}`
	}

	function hasDirentReference(ino: Ino): boolean {
		for (const entry of dirs.values()) {
			if (entry.ino === ino) return true
		}
		return false
	}

	function defaultMode(type: FileType): number {
		return type === FileType.Directory ? 0o755 : type === FileType.Symlink ? 0o777 : 0o644
	}

	const caps: StorageCapabilities = {
		async getXattr(ino, name) {
			return xattrs.get(ino)?.get(name)?.slice() ?? null
		},
		async setXattr(ino, name, value) {
			let m = xattrs.get(ino)
			if (!m) {
				m = new Map()
				xattrs.set(ino, m)
			}
			m.set(name, value.slice())
		},
		async listXattrs(ino) {
			return [...(xattrs.get(ino)?.keys() ?? [])]
		},
		async removeXattr(ino, name) {
			const m = xattrs.get(ino)
			if (!m) return
			m.delete(name)
			if (m.size === 0) xattrs.delete(ino)
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
			return metas.get(ino) ?? null
		},

		async setMeta(ino, patch, options) {
			const existing = metas.get(ino)
			if (existing) {
				metas.set(ino, { ...existing, ...patch })
				emit({ ino, kind: 'meta', source: options?.source })
				return
			}
			if (patch.type === undefined) return
			const now = 0n
			const full: InodeMeta = {
				type: patch.type,
				size: patch.size ?? 0n,
				mode: patch.mode ?? defaultMode(patch.type),
				mtimeNs: patch.mtimeNs ?? now,
				ctimeNs: patch.ctimeNs ?? now,
				contentHash: patch.contentHash,
				symlinkTarget: patch.symlinkTarget
			}
			metas.set(ino, full)
			if (patch.type === FileType.Regular) blobs.set(ino, new Uint8Array())
			emit({ ino, kind: 'meta', source: options?.source })
		},

		async deleteInode(ino) {
			if (hasDirentReference(ino)) return
			metas.delete(ino)
			blobs.delete(ino)
			xattrs.delete(ino)
			emit({ ino, kind: 'meta' })
		},

		async getBlob(ino) {
			return blobs.get(ino)?.slice() ?? new Uint8Array()
		},

		async putBlob(ino, data, options) {
			blobs.set(ino, data.slice())
			const meta = metas.get(ino)
			if (meta) metas.set(ino, { ...meta, size: BigInt(data.length) })
			emit({ ino, kind: 'content', source: options?.source })
		},

		async getDirent(dirIno, name) {
			return dirs.get(dirKey(dirIno, name)) ?? null
		},

		async putDirent(dirIno, name, entry, options) {
			dirs.set(dirKey(dirIno, name), entry)
			emit({ ino: entry.ino, kind: 'dirent', dirIno, name, source: options?.source })
		},

		async deleteDirent(dirIno, name, options) {
			const existing = dirs.get(dirKey(dirIno, name))
			dirs.delete(dirKey(dirIno, name))
			if (existing)
				emit({ ino: existing.ino, kind: 'dirent', dirIno, name, source: options?.source })
		},

		async listDirents(dirIno, cursor) {
			const prefix = `${dirIno}\0`
			const entries: { name: string; ino: Ino; type: FileType }[] = []
			for (const [key, entry] of dirs) {
				if (!key.startsWith(prefix)) continue
				const name = key.slice(prefix.length)
				if (cursor === '' || name > cursor) {
					entries.push({ name, ino: entry.ino, type: entry.type })
				}
			}
			return { entries, next: '' }
		}
	}
}
