import type { Storage, StorageCapabilities, InodeMeta } from './storage'
import { FileType } from './types'
import type { Ino, DirentMin } from './types'

export function memStorage(): Storage {
	const metas = new Map<Ino, InodeMeta>()
	const blobs = new Map<Ino, Uint8Array>()
	const dirs = new Map<string, DirentMin>()   // key: `${dirIno}\0${name}`
	const xattrs = new Map<Ino, Map<string, Uint8Array>>()
	const rootIno = '1'

	metas.set(rootIno, {
		type: FileType.Directory,
		size: 0n,
		mode: 0o755,
		mtimeNs: 0n,
		ctimeNs: 0n,
	})

	function dirKey(dirIno: Ino, name: string): string {
		return `${dirIno}\0${name}`
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
			if (!m) { m = new Map(); xattrs.set(ino, m) }
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
	}

	return {
		rootIno,
		caps,

		async getMeta(ino) {
			return metas.get(ino) ?? null
		},

		async setMeta(ino, patch) {
			const existing = metas.get(ino)
			if (existing) {
				metas.set(ino, { ...existing, ...patch })
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
				symlinkTarget: patch.symlinkTarget,
			}
			metas.set(ino, full)
			if (patch.type === FileType.Regular) blobs.set(ino, new Uint8Array())
		},

		async deleteInode(ino) {
			metas.delete(ino)
			blobs.delete(ino)
			xattrs.delete(ino)
		},

		async getBlob(ino) {
			return blobs.get(ino)?.slice() ?? new Uint8Array()
		},

		async putBlob(ino, data) {
			blobs.set(ino, data.slice())
			const meta = metas.get(ino)
			if (meta) metas.set(ino, { ...meta, size: BigInt(data.length) })
		},

		async getDirent(dirIno, name) {
			return dirs.get(dirKey(dirIno, name)) ?? null
		},

		async putDirent(dirIno, name, entry) {
			dirs.set(dirKey(dirIno, name), entry)
		},

		async deleteDirent(dirIno, name) {
			dirs.delete(dirKey(dirIno, name))
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
		},
	}
}
