import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase, IDBPTransaction } from 'idb'
import type { StorageBackend, InodeMeta, FsOp, MutationOptions, UpdateQueryOptions } from './storage'
import { FileType } from './types'
import type { Ino, Off, DirCursor } from './types'

// ---------------------------------------------------------------------------
// IDB schema
// ---------------------------------------------------------------------------

interface InodeRecord extends InodeMeta {
	ino: Ino
	lastAccessedAt: number
}

interface ContentRecord {
	ino: Ino
	data: Uint8Array
	sizeBytes: number
	lastAccessedAt: number
}

interface DirRecord {
	dirIno: Ino
	name: string
	ino: Ino
	type: FileType
}

interface XattrRecord {
	ino: Ino
	name: string
	value: Uint8Array
}

interface DirtyRecord {
	ino: Ino
	markedAt: number
}

interface UpdateRecord {
	seq?: number
	op: FsOp
}

interface GhostoreFsSchema extends DBSchema {
	inodes: { key: string; value: InodeRecord }
	content: {
		key: string
		value: ContentRecord
		indexes: { 'by-lru': number }
	}
	dirs: {
		key: [string, string]
		value: DirRecord
		indexes: { 'by-dir': string }
	}
	xattrs: {
		key: [string, string]
		value: XattrRecord
		indexes: { 'by-ino': string }
	}
	dirty: { key: string; value: DirtyRecord }
	updates: {
		key: number
		value: UpdateRecord
	}
	meta: { key: string; value: unknown }
}

type Db = IDBPDatabase<GhostoreFsSchema>
type AllStores = ('inodes' | 'content' | 'dirs' | 'xattrs' | 'dirty' | 'updates' | 'meta')[]
type FullTx = IDBPTransaction<GhostoreFsSchema, AllStores, 'readwrite'>
type KeyRangeLike = NonNullable<Parameters<Db['getAll']>[1]>
const KeyRange = (globalThis as unknown as {
	IDBKeyRange: {
		bound(
			lower: [string, string],
			upper: [string, string],
			lowerOpen?: boolean,
			upperOpen?: boolean
		): KeyRangeLike
		lowerBound(lower: number): KeyRangeLike
		upperBound(upper: number): KeyRangeLike
	}
}).IDBKeyRange

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_VERSION = 2
const DEFAULT_CONTENT_CAP = 50 * 1024 * 1024 // 50 MB
const ROOT_INO: Ino = '1'
const DIR_PAGE = 100

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(data))
	return toHex(new Uint8Array(digest))
}

export type IdbStorageBackend = StorageBackend & {
	/** Root directory inode — always '1' for this backend. */
	readonly rootIno: Ino
	/** Close the database and release resources. */
	destroy(): void
}

/**
 * IndexedDB-backed StorageBackend with LRU content eviction.
 *
 * Uses seven object stores:
 *   inodes   — inode metadata
 *   content  — file data (subject to LRU eviction up to contentCapBytes)
 *   dirs     — directory entries keyed by [dirIno, name]
 *   xattrs   — extended attributes keyed by [ino, name]
 *   dirty    — inodes with unflushed writes (for the sync layer)
 *   updates  — append-only local operation log for outbound sync
 *   meta     — key-value bootstrap state (rootIno, totalContentBytes, etc.)
 *
 * The root inode is always '1' (matching the memStorage convention and
 * the current fs.ts hardcoding).
 */
export function idbStorage(
	dbName: string,
	options?: { contentCapBytes?: number },
): IdbStorageBackend {
	const cap = options?.contentCapBytes ?? DEFAULT_CONTENT_CAP
	let dbPromise: Promise<Db> | null = null

	// ---------------------------------------------------------------------------
	// DB lifecycle
	// ---------------------------------------------------------------------------

	function getDb(): Promise<Db> {
		if (!dbPromise) {
			dbPromise = openDB<GhostoreFsSchema>(dbName, DB_VERSION, {
				upgrade(db, oldVersion) {
					if (oldVersion < 1) {
						db.createObjectStore('inodes', { keyPath: 'ino' })

						const contentStore = db.createObjectStore('content', { keyPath: 'ino' })
						contentStore.createIndex('by-lru', 'lastAccessedAt')

						const dirStore = db.createObjectStore('dirs', { keyPath: ['dirIno', 'name'] })
						dirStore.createIndex('by-dir', 'dirIno')

						const xattrStore = db.createObjectStore('xattrs', { keyPath: ['ino', 'name'] })
						xattrStore.createIndex('by-ino', 'ino')

						db.createObjectStore('dirty', { keyPath: 'ino' })
						db.createObjectStore('meta')
					}
					if (oldVersion < 2 && !db.objectStoreNames.contains('updates')) {
						db.createObjectStore('updates', { keyPath: 'seq', autoIncrement: true })
					}
				},
				blocked() {
					console.warn(`[idbStorage] DB "${dbName}" is blocked — another tab may be open`)
				},
			}).then(async (db) => {
				// Bootstrap root inode on first open
				const existing = await db.get('meta', 'rootIno')
				if (!existing) {
					const now = Date.now()
					const tx = db.transaction(['inodes', 'meta'], 'readwrite')
					await tx.objectStore('inodes').put({
						ino: ROOT_INO,
						type: FileType.Directory,
						size: 0n,
						mode: 0o755,
						nlink: 1,
						mtimeNs: BigInt(now) * 1_000_000n,
						ctimeNs: BigInt(now) * 1_000_000n,
						lastAccessedAt: now,
					})
					await tx.objectStore('meta').put(ROOT_INO, 'rootIno')
					await tx.objectStore('meta').put(0, 'totalContentBytes')
					await tx.done
				}
				return db
			})
		}
		return dbPromise
	}

	// ---------------------------------------------------------------------------
	// LRU helpers
	// ---------------------------------------------------------------------------

	/**
	 * Evict least-recently-accessed, non-dirty content entries until adding
	 * `addingBytes` would not exceed the cap. Does NOT evict the inode being
	 * written (skipIno) nor any dirty inodes (unflushed writes must survive).
	 * Updates totalContentBytes in the meta store.
	 *
	 * Cap enforcement is best-effort: a single write whose size exceeds the cap
	 * cannot be prevented (we must persist it), but all evictable content is
	 * cleared before accepting the oversized write.
	 */
	async function evictContent(db: Db, addingBytes: number, skipIno: Ino): Promise<void> {
		const total = (await db.get('meta', 'totalContentBytes') as number | undefined) ?? 0
		if (total + addingBytes <= cap) return

		// Include 'dirty' so we can check per-entry whether eviction is safe
		const tx = db.transaction(['content', 'dirty', 'meta'], 'readwrite')
		const lruIndex = tx.objectStore('content').index('by-lru')

		let running = total
		let cursor = await lruIndex.openCursor()
		// Stop as soon as enough space is freed. When a candidate is dirty,
		// skip it without stopping — keep scanning for the next clean entry.
		while (cursor && running + addingBytes > cap) {
			const { ino, sizeBytes } = cursor.value
			if (ino !== skipIno) {
				// Never evict dirty content — it has unflushed writes
				const isDirty = await tx.objectStore('dirty').get(ino)
				if (!isDirty) {
					running -= sizeBytes
					await cursor.delete()
				}
			}
			cursor = await cursor.continue()
		}

		await tx.objectStore('meta').put(Math.max(0, running), 'totalContentBytes')
		await tx.done
	}

	/**
	 * Atomically write content, update inode size, mark dirty, update total.
	 * Caller must call evictContent first if needed.
	 */
	async function writeContent(
		db: Db,
		ino: Ino,
		data: Uint8Array,
		oldSize: number,
		options?: MutationOptions,
	): Promise<void> {
		const now = Date.now()
		const newSize = data.length
		const contentHash = await sha256Hex(data)
		const tx = db.transaction(['content', 'inodes', 'dirty', 'updates', 'meta'], 'readwrite')

		await tx.objectStore('content').put({ ino, data, sizeBytes: newSize, lastAccessedAt: now })

		const inode = await tx.objectStore('inodes').get(ino)
		if (inode) {
			const nextInode = { ...inode, size: BigInt(newSize), contentHash }
			await tx.objectStore('inodes').put(nextInode)
			await tx.objectStore('updates').add({
				op: {
					kind: 'upsert-inode',
					source: options?.source,
					ino,
					meta: metaFromRecord(nextInode),
				},
			})
		}

		await tx.objectStore('dirty').put({ ino, markedAt: now })

		const total = (await tx.objectStore('meta').get('totalContentBytes') as number | undefined) ?? 0
		await tx.objectStore('meta').put(total - oldSize + newSize, 'totalContentBytes')
		await tx.done
	}

function defaultModeForType(type: FileType): number {
	switch (type) {
		case FileType.Directory:
			return 0o755
		case FileType.Symlink:
			return 0o777
		case FileType.Regular:
		default:
			return 0o644
	}
}

function buildMissingInodeRecord(ino: Ino, partial: Partial<InodeMeta>, now = Date.now()): InodeRecord | null {
	if (partial.type === undefined) return null
	const stamp = BigInt(now) * 1_000_000n
	return {
		ino,
		type: partial.type,
		size: partial.size ?? 0n,
		mode: partial.mode ?? defaultModeForType(partial.type),
		nlink: partial.nlink ?? 0,
		mtimeNs: partial.mtimeNs ?? stamp,
		ctimeNs: partial.ctimeNs ?? stamp,
		contentHash: partial.contentHash,
		symlinkTarget: partial.symlinkTarget,
		lastAccessedAt: now,
	}
}

function metaFromRecord(record: InodeRecord): InodeMeta {
	const { ino: _ino, lastAccessedAt: _lastAccessedAt, ...meta } = record
	return meta
}

	function filterOpsBySource(ops: FsOp[], options?: UpdateQueryOptions): FsOp[] {
		const source = options?.source
		const mode = options?.sourceMode ?? 'only'
		if (!source) return ops
		return ops.filter((op) => mode === 'exclude' ? op.source !== source : op.source === source)
	}

	async function listAllXattrsInTx(tx: FullTx, ino: Ino): Promise<Record<string, Uint8Array>> {
		const records = await tx.objectStore('xattrs').index('by-ino').getAll(ino)
		return Object.fromEntries(records.map((record) => [record.name, record.value.slice()]))
	}

	/**
	 * Free an inode and all associated data (content, xattrs, dir children).
	 * Used when nlink reaches 0.
	 */
	async function freeIno(
		tx: FullTx,
		ino: Ino,
		type: FileType,
	): Promise<void> {
		await tx.objectStore('inodes').delete(ino)
		await tx.objectStore('dirty').delete(ino)

		if (type === FileType.Regular) {
			// Update totalContentBytes before deleting
			const rec = await tx.objectStore('content').get(ino)
			if (rec) {
				const total = (await tx.objectStore('meta').get('totalContentBytes') as number | undefined) ?? 0
				await tx.objectStore('meta').put(Math.max(0, total - rec.sizeBytes), 'totalContentBytes')
				await tx.objectStore('content').delete(ino)
			}
		}

		if (type === FileType.Directory) {
			// Delete all child dir entries
			const childKeys = await tx.objectStore('dirs').index('by-dir').getAllKeys(ino)
			for (const k of childKeys) {
				await tx.objectStore('dirs').delete(k)
			}
		}

		// Delete all xattrs
		const xkeys = await tx.objectStore('xattrs').index('by-ino').getAllKeys(ino)
		for (const k of xkeys) {
			await tx.objectStore('xattrs').delete(k)
		}
	}

	// ---------------------------------------------------------------------------
	// StorageBackend implementation
	// ---------------------------------------------------------------------------

	return {
		rootIno: ROOT_INO,

		destroy() {
			dbPromise?.then((db) => db.close()).catch(() => {})
			dbPromise = null
		},

		// --- alloc / create ---

		async alloc(meta, options) {
			const db = await getDb()
			const ino = crypto.randomUUID()
			const now = Date.now()
			const tx = db.transaction(['inodes', 'content', 'updates'], 'readwrite')
			await tx.objectStore('inodes').put({ ino, ...meta, nlink: 0, lastAccessedAt: now })
			if (meta.type === FileType.Regular) {
				await tx.objectStore('content').put({ ino, data: new Uint8Array(), sizeBytes: 0, lastAccessedAt: now })
			}
			await tx.objectStore('updates').add({
				op: {
					kind: 'upsert-inode',
					source: options?.source,
					ino,
					meta: { ...meta, nlink: 0 },
				},
			})
			await tx.done
			return ino
		},

		async create(dirIno, name, meta, options) {
			const db = await getDb()
			const tx = db.transaction(['inodes', 'content', 'dirs', 'updates'], 'readwrite')
			const existing = await tx.objectStore('dirs').get([dirIno, name])
			if (existing) throw new Error(`EEXIST: ${name}`)

			const ino = crypto.randomUUID()
			const now = Date.now()
			await tx.objectStore('inodes').put({ ino, ...meta, nlink: 1, lastAccessedAt: now })
			if (meta.type === FileType.Regular) {
				await tx.objectStore('content').put({ ino, data: new Uint8Array(), sizeBytes: 0, lastAccessedAt: now })
			}
			await tx.objectStore('dirs').put({ dirIno, name, ino, type: meta.type })
			await tx.objectStore('updates').add({
				op: {
					kind: 'upsert-inode',
					source: options?.source,
					ino,
					meta: { ...meta, nlink: 0 },
				},
			})
			await tx.objectStore('updates').add({
				op: {
					kind: 'set-dirent',
					source: options?.source,
					dirIno,
					name,
					ino,
					type: meta.type,
				},
			})
			await tx.done
			return ino
		},

		// --- inode metadata ---

		async getMeta(ino) {
			const db = await getDb()
			const rec = await db.get('inodes', ino)
			if (!rec) return null
			const { lastAccessedAt: _laa, ino: _ino, ...meta } = rec
			return meta
		},

		async setMeta(ino, partial, options) {
			const db = await getDb()
			const tx = db.transaction(['inodes', 'updates', 'content'], 'readwrite')
			const rec = await tx.objectStore('inodes').get(ino)
			if (!rec) {
				const next = buildMissingInodeRecord(ino, partial)
				if (!next) {
					await tx.done
					return
				}
				await tx.objectStore('inodes').put(next)
				if (next.type === FileType.Regular) {
					await tx.objectStore('content').put({
						ino,
						data: new Uint8Array(),
						sizeBytes: 0,
						lastAccessedAt: next.lastAccessedAt,
					})
				}
				await tx.objectStore('updates').add({
					op: {
						kind: 'upsert-inode',
						source: options?.source,
						ino,
						meta: { ...partial },
					},
				})
				await tx.done
				return
			}
			const next = { ...rec, ...partial }
			await tx.objectStore('inodes').put(next)
			await tx.objectStore('updates').add({
				op: {
					kind: 'upsert-inode',
					source: options?.source,
					ino,
					meta: { ...partial },
				},
			})
			await tx.done
		},

		// --- xattrs ---

		async getXattr(ino, name) {
			const db = await getDb()
			const rec = await db.get('xattrs', [ino, name])
			return rec ? rec.value.slice() : null
		},

		async setXattr(ino, name, value, options) {
			const db = await getDb()
			const tx = db.transaction(['xattrs', 'updates', 'inodes'], 'readwrite')
			await tx.objectStore('xattrs').put({ ino, name, value: value.slice() })
			const inode = await tx.objectStore('inodes').get(ino)
			const xattrs = await listAllXattrsInTx(tx as FullTx, ino)
			await tx.objectStore('updates').add({
				op: {
					kind: 'upsert-inode',
					source: options?.source,
					ino,
					meta: inode ? metaFromRecord(inode) : undefined,
					xattrs,
				},
			})
			await tx.done
		},

		async listXattr(ino) {
			const db = await getDb()
			const keys = await db.getAllKeysFromIndex('xattrs', 'by-ino', ino)
			return keys.map((k) => k[1])
		},

		async removeXattr(ino, name, options) {
			const db = await getDb()
			const tx = db.transaction(['xattrs', 'updates', 'inodes'], 'readwrite')
			await tx.objectStore('xattrs').delete([ino, name])
			const inode = await tx.objectStore('inodes').get(ino)
			const xattrs = await listAllXattrsInTx(tx as FullTx, ino)
			await tx.objectStore('updates').add({
				op: {
					kind: 'upsert-inode',
					source: options?.source,
					ino,
					meta: inode ? metaFromRecord(inode) : undefined,
					xattrs,
				},
			})
			await tx.done
		},

		// --- data I/O ---

		async read(ino, offset: Off, length) {
			const db = await getDb()
			const tx = db.transaction(['content'], 'readwrite')
			const rec = await tx.objectStore('content').get(ino)
			if (!rec) return new Uint8Array()
			// Touch lastAccessedAt for LRU tracking
			await tx.objectStore('content').put({ ...rec, lastAccessedAt: Date.now() })
			await tx.done
			const start = Number(offset)
			return rec.data.slice(start, start + length)
		},

		async write(ino, offset: Off, chunk, options) {
			const db = await getDb()
			const existing = await db.get('content', ino)
			const start = Number(offset)
			const end = start + chunk.length

			let buf = existing?.data ?? new Uint8Array()
			if (end > buf.length) {
				const grown = new Uint8Array(end)
				grown.set(buf)
				buf = grown
			} else {
				buf = buf.slice()
			}
			buf.set(chunk, start)

			const oldSize = existing?.sizeBytes ?? 0
			const delta = buf.length - oldSize
			if (delta > 0) await evictContent(db, delta, ino)
			await writeContent(db, ino, buf, oldSize, options)
			return chunk.length
		},

		async truncate(ino, size: Off, options) {
			const db = await getDb()
			const n = Number(size)
			const existing = await db.get('content', ino)
			const oldData = existing?.data ?? new Uint8Array()
			const oldSize = existing?.sizeBytes ?? 0

			const next = new Uint8Array(n)
			next.set(oldData.subarray(0, n))

			const delta = n - oldSize
			if (delta > 0) await evictContent(db, delta, ino)
			await writeContent(db, ino, next, oldSize, options)
		},

		// --- directory operations ---

		async dirLookup(dirIno, name) {
			const db = await getDb()
			const rec = await db.get('dirs', [dirIno, name])
			return rec ? { ino: rec.ino, type: rec.type } : null
		},

		async dirList(dirIno, cursor: DirCursor) {
			const db = await getDb()
			// Use compound key range on the primary key [dirIno, name]
			const lower: [string, string] = [dirIno, cursor]
			const upper: [string, string] = [dirIno, '\uffff']
			const range = KeyRange.bound(lower, upper, cursor !== '', false) as never

			const records = await db.getAll('dirs', range, DIR_PAGE + 1)
			const hasMore = records.length > DIR_PAGE
			const page = records.slice(0, DIR_PAGE)

			return {
				entries: page.map((r) => ({ name: r.name, ino: r.ino, type: r.type })),
				next: (hasMore ? (page[DIR_PAGE - 1]?.name ?? '') : '') as DirCursor,
			}
		},

		async dirAdd(dirIno, name, ino, type, options) {
			const db = await getDb()
			const tx = db.transaction(['dirs', 'inodes', 'updates'], 'readwrite')
			const existing = await tx.objectStore('dirs').get([dirIno, name])
			if (existing) {
				await tx.done
				return false
			}
			await tx.objectStore('dirs').put({ dirIno, name, ino, type })
			const inode = await tx.objectStore('inodes').get(ino)
			if (inode) {
				await tx.objectStore('inodes').put({ ...inode, nlink: inode.nlink + 1 })
			}
			await tx.objectStore('updates').add({
				op: {
					kind: 'set-dirent',
					source: options?.source,
					dirIno,
					name,
					ino,
					type,
				},
			})
			await tx.done
			return true
		},

		async dirSet(dirIno, name, ino, type, options) {
			const db = await getDb()
			const tx = db.transaction(['dirs', 'inodes', 'content', 'xattrs', 'dirty', 'updates', 'meta'], 'readwrite')
			const displaced = await tx.objectStore('dirs').get([dirIno, name]) ?? null

			await tx.objectStore('dirs').put({ dirIno, name, ino, type })

			// Only increment nlink when this ino was not already at this slot.
			// If displaced.ino === ino the +1 and the -1 below cancel out; skip
			// both to avoid a spurious nlink round-trip that would leak a ref.
			if (!displaced || displaced.ino !== ino) {
				const incoming = await tx.objectStore('inodes').get(ino)
				if (incoming) {
					await tx.objectStore('inodes').put({ ...incoming, nlink: incoming.nlink + 1 })
				}
			}

			// Handle displaced inode (always a different inode at this point)
			if (displaced && displaced.ino !== ino) {
				const disp = await tx.objectStore('inodes').get(displaced.ino)
				if (disp) {
					const newNlink = disp.nlink - 1
					if (newNlink <= 0) {
						await freeIno(tx as FullTx, displaced.ino, displaced.type)
					} else {
						await tx.objectStore('inodes').put({ ...disp, nlink: newNlink })
					}
				}
			}

			await tx.objectStore('updates').add({
				op: {
					kind: 'set-dirent',
					source: options?.source,
					dirIno,
					name,
					ino,
					type,
				},
			})
			await tx.done
			return displaced ? { ino: displaced.ino, type: displaced.type } : null
		},


		async dirUnset(dirIno, name, options) {
			const db = await getDb()
			const tx = db.transaction(['dirs', 'inodes', 'content', 'xattrs', 'dirty', 'updates', 'meta'], 'readwrite')
			const entry = await tx.objectStore('dirs').get([dirIno, name]) ?? null
			if (!entry) {
				await tx.done
				return null
			}

			await tx.objectStore('dirs').delete([dirIno, name])

			const inode = await tx.objectStore('inodes').get(entry.ino)
			if (inode) {
				const newNlink = inode.nlink - 1
				if (newNlink <= 0) {
						await freeIno(tx as FullTx, entry.ino, entry.type)
				} else {
					await tx.objectStore('inodes').put({ ...inode, nlink: newNlink })
				}
			}

			await tx.objectStore('updates').add({
				op: {
					kind: 'unset-dirent',
					source: options?.source,
					dirIno,
					name,
					ino: entry.ino,
				},
			})
			await tx.done
			return { ino: entry.ino, type: entry.type }
		},

		// --- putBlob ---

		async putBlob(ino, data, options) {
			const db = await getDb()
			const existing = await db.get('content', ino)
			const oldSize = existing?.sizeBytes ?? 0
			const delta = data.length - oldSize
			if (delta > 0) await evictContent(db, delta, ino)
			await writeContent(db, ino, data.slice(), oldSize, options)
		},

		async updates(cursor: string, options) {
			const db = await getDb()
			const since = cursor === '' ? 0 : Number.parseInt(cursor, 10)
			if (Number.isFinite(since) && since > 0) {
				const compactTx = db.transaction(['updates'], 'readwrite')
				const compactStore = compactTx.objectStore('updates')
				let record = await compactStore.openCursor(KeyRange.upperBound(since) as never)
				while (record) {
					await record.delete()
					record = await record.continue()
				}
				await compactTx.done
			}

			const lowerBound = Number.isFinite(since) && since > 0 ? since + 1 : 1
			const range = KeyRange.lowerBound(lowerBound) as never
			const records = await db.getAll('updates', range)
			const keys = await db.getAllKeys('updates', range)
			const nextCursor = keys.length > 0 ? String(keys[keys.length - 1]) : cursor
			return {
				ops: filterOpsBySource(records.map((record) => record.op), options),
				cursor: nextCursor,
			}
		},
	}
}
