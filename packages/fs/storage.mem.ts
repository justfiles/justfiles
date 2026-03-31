import type { StorageBackend, InodeMeta } from './storage'
import { FileType } from './types'
import type { Ino, Off, DirCursor } from './types'

type Entry = { ino: Ino; type: FileType }

/**
 * Minimal in-memory StorageBackend for testing.
 * No optimisation, no persistence, no concurrency safety.
 */
export function memStorage(): StorageBackend {
	const metas = new Map<Ino, InodeMeta>()
	const blobs = new Map<Ino, Uint8Array>()
	const dirs = new Map<Ino, Map<string, Entry>>()
	let nextIno = 2

	metas.set('1', { type: FileType.Directory, size: 0n, mode: 0o755, nlink: 1, mtimeNs: 0n, ctimeNs: 0n })
	dirs.set('1', new Map())

	function addIno(ino: Ino, m: InodeMeta): void {
		metas.set(ino, m)
		if (m.type === FileType.Regular) blobs.set(ino, new Uint8Array())
		if (m.type === FileType.Directory) dirs.set(ino, new Map())
	}

	function free(ino: Ino): void {
		metas.delete(ino)
		blobs.delete(ino)
		dirs.delete(ino)
	}

	function adjustNlink(ino: Ino, delta: number): void {
		const m = metas.get(ino)
		if (!m) return
		const nlink = m.nlink + delta
		if (nlink <= 0) free(ino)
		else metas.set(ino, { ...m, nlink })
	}

	return {
		async alloc(m) {
			const ino = String(nextIno++)
			addIno(ino, { ...m, nlink: 0 })
			return ino
		},

		async create(dirIno, name, m) {
			const dir = dirs.get(dirIno)!
			if (dir.has(name)) throw new Error(`EEXIST: ${name}`)
			const ino = String(nextIno++)
			addIno(ino, { ...m, nlink: 1 })
			dir.set(name, { ino, type: m.type })
			return ino
		},

		async getMeta(ino) {
			return metas.get(ino) ?? null
		},

		async setMeta(ino, partial) {
			const m = metas.get(ino)
			if (m) metas.set(ino, { ...m, ...partial })
		},

		async read(ino, offset: Off, length) {
			const buf = blobs.get(ino) ?? new Uint8Array()
			const start = Number(offset)
			return buf.subarray(start, start + length)
		},

		async write(ino, offset: Off, chunk) {
			const start = Number(offset)
			const end = start + chunk.length
			let buf = blobs.get(ino) ?? new Uint8Array()
			if (end > buf.length) {
				const grown = new Uint8Array(end)
				grown.set(buf)
				buf = grown
			}
			buf.set(chunk, start)
			blobs.set(ino, buf)
			const m = metas.get(ino)
			if (m) metas.set(ino, { ...m, size: BigInt(buf.length) })
			return chunk.length
		},

		async truncate(ino, size: Off) {
			const n = Number(size)
			const buf = blobs.get(ino) ?? new Uint8Array()
			const next = new Uint8Array(n)
			next.set(buf.subarray(0, n))
			blobs.set(ino, next)
			const m = metas.get(ino)
			if (m) metas.set(ino, { ...m, size })
		},

		async dirLookup(dirIno, name) {
			return dirs.get(dirIno)?.get(name) ?? null
		},

		async dirList(dirIno, cursor: DirCursor) {
			if (cursor !== '') return { entries: [], next: '' as DirCursor }
			const entries = [...(dirs.get(dirIno) ?? new Map()).entries()]
				.map(([name, { ino, type }]) => ({ name, ino, type }))
			return { entries, next: '' as DirCursor }
		},

		async dirAdd(dirIno, name, ino, type) {
			const dir = dirs.get(dirIno)!
			if (dir.has(name)) return false
			dir.set(name, { ino, type })
			adjustNlink(ino, +1)
			return true
		},

		async dirSet(dirIno, name, ino, type) {
			const dir = dirs.get(dirIno)!
			const displaced = dir.get(name) ?? null
			dir.set(name, { ino, type })
			adjustNlink(ino, +1)
			if (displaced) adjustNlink(displaced.ino, -1)
			return displaced
		},

		async dirUnset(dirIno, name) {
			const dir = dirs.get(dirIno)!
			const entry = dir.get(name) ?? null
			if (!entry) return null
			dir.delete(name)
			adjustNlink(entry.ino, -1)
			return entry
		},
	}
}
