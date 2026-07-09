import type { DBSchema, IDBPDatabase, IDBPTransaction } from 'idb'
import { openDB } from 'idb'
import type { InodeMeta, Storage, StorageCapabilities, StorageChange } from './storage'
import type { Ino } from './types'
import { FileType } from './types'

// ---------------------------------------------------------------------------
// IDB schema
// ---------------------------------------------------------------------------

interface InodeRecord {
	ino: Ino
	type: FileType
	size: bigint
	mode: number
	mtimeNs: bigint
	ctimeNs: bigint
	contentHash?: string
	symlinkTarget?: string
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
	meta: { key: string; value: unknown }
}

type Db = IDBPDatabase<GhostoreFsSchema>
type AllStores = ('inodes' | 'content' | 'dirs' | 'xattrs' | 'dirty' | 'meta')[]
type FullTx = IDBPTransaction<GhostoreFsSchema, AllStores, 'readwrite'>
type KeyRangeLike = NonNullable<Parameters<Db['getAll']>[1]>
const KeyRange = (
	globalThis as unknown as {
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
	}
).IDBKeyRange

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_VERSION = 4
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

export type IdbStorage = Storage & {
	/** Root directory inode — always '1' for this backend. */
	readonly rootIno: Ino
	/** Close the database and release resources. */
	destroy(): void
}

/**
 * IndexedDB-backed Storage with LRU content eviction.
 *
 * Uses seven object stores:
 *   inodes   — inode metadata (no nlink)
 *   content  — file data (subject to LRU eviction up to contentCapBytes)
 *   dirs     — directory entries keyed by [dirIno, name]
 *   xattrs   — extended attributes keyed by [ino, name]
 *   dirty    — inodes with unflushed writes (for the sync layer)
 *   meta     — key-value bootstrap state (rootIno, totalContentBytes, etc.)
 *
 * The root inode is always '1' (matching the memStorage convention).
 */
export function idbStorage(dbName: string, options?: { contentCapBytes?: number }): IdbStorage {
	const cap = options?.contentCapBytes ?? DEFAULT_CONTENT_CAP
	let dbPromise: Promise<Db> | null = null

	// Change feed — the substrate for volume.watch. Listeners fire after a
	// mutation's transaction commits; near-zero cost when nobody is listening.
	const listeners = new Set<(change: StorageChange) => void>()
	function emit(change: StorageChange): void {
		if (listeners.size === 0) return
		for (const fn of [...listeners]) fn(change)
	}

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
					if (oldVersion < 3) {
						// Recreate inodes store without nlink column.
						// Data migration not required — existing data bootstrapped via sync.
						if (db.objectStoreNames.contains('inodes')) {
							db.deleteObjectStore('inodes')
						}
						db.createObjectStore('inodes', { keyPath: 'ino' })
					}
					if (oldVersion < 4 && (db as IDBPDatabase).objectStoreNames.contains('updates')) {
						// Drop the legacy FsOp delta log — replaced by the path journal
						// (owned by the SyncReplica), which the outbound sync now reads.
						;(db as IDBPDatabase).deleteObjectStore('updates')
					}
				},
				blocked() {
					console.warn(`[idbStorage] DB "${dbName}" is blocked — another tab may be open`)
				}
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
						mtimeNs: BigInt(now) * 1_000_000n,
						ctimeNs: BigInt(now) * 1_000_000n,
						lastAccessedAt: now
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

	async function hasDirentReference(db: Db, ino: Ino): Promise<boolean> {
		const rows = await db.getAll('dirs')
		return rows.some((row) => row.ino === ino)
	}

	// ---------------------------------------------------------------------------
	// LRU helpers
	// ---------------------------------------------------------------------------

	async function evictContent(db: Db, addingBytes: number, skipIno: Ino): Promise<void> {
		const total = ((await db.get('meta', 'totalContentBytes')) as number | undefined) ?? 0
		if (total + addingBytes <= cap) return

		const tx = db.transaction(['content', 'dirty', 'meta'], 'readwrite')
		const lruIndex = tx.objectStore('content').index('by-lru')

		let running = total
		let cursor = await lruIndex.openCursor()
		while (cursor && running + addingBytes > cap) {
			const { ino, sizeBytes } = cursor.value
			if (ino !== skipIno) {
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

	function metaFromRecord(record: InodeRecord): InodeMeta {
		const { ino: _ino, lastAccessedAt: _lastAccessedAt, ...meta } = record
		return meta
	}

	/**
	 * Atomically write content, update inode size and contentHash, mark dirty, update total.
	 * Caller must call evictContent first if needed.
	 */
	async function writeContent(db: Db, ino: Ino, data: Uint8Array, oldSize: number): Promise<void> {
		const now = Date.now()
		const newSize = data.length
		const contentHash = await sha256Hex(data)
		const tx = db.transaction(['content', 'inodes', 'dirty', 'meta'], 'readwrite')

		await tx.objectStore('content').put({ ino, data, sizeBytes: newSize, lastAccessedAt: now })

		const inode = await tx.objectStore('inodes').get(ino)
		if (inode) {
			const nextInode = { ...inode, size: BigInt(newSize), contentHash }
			await tx.objectStore('inodes').put(nextInode)
		}

		await tx.objectStore('dirty').put({ ino, markedAt: now })

		const total =
			((await tx.objectStore('meta').get('totalContentBytes')) as number | undefined) ?? 0
		await tx.objectStore('meta').put(total - oldSize + newSize, 'totalContentBytes')
		await tx.done
	}

	function defaultModeForType(type: FileType): number {
		switch (type) {
			case FileType.Directory:
				return 0o755
			case FileType.Symlink:
				return 0o777
			default:
				return 0o644
		}
	}

	function buildMissingInodeRecord(
		ino: Ino,
		partial: Partial<InodeMeta>,
		now = Date.now()
	): InodeRecord | null {
		if (partial.type === undefined) return null
		const stamp = BigInt(now) * 1_000_000n
		return {
			ino,
			type: partial.type,
			size: partial.size ?? 0n,
			mode: partial.mode ?? defaultModeForType(partial.type),
			mtimeNs: partial.mtimeNs ?? stamp,
			ctimeNs: partial.ctimeNs ?? stamp,
			contentHash: partial.contentHash,
			symlinkTarget: partial.symlinkTarget,
			lastAccessedAt: now
		}
	}

	async function freeIno(tx: FullTx, ino: Ino, type: FileType): Promise<void> {
		await tx.objectStore('inodes').delete(ino)
		await tx.objectStore('dirty').delete(ino)

		if (type === FileType.Regular) {
			const rec = await tx.objectStore('content').get(ino)
			if (rec) {
				const total =
					((await tx.objectStore('meta').get('totalContentBytes')) as number | undefined) ?? 0
				await tx.objectStore('meta').put(Math.max(0, total - rec.sizeBytes), 'totalContentBytes')
				await tx.objectStore('content').delete(ino)
			}
		}

		// Delete all xattrs
		const xkeys = await tx.objectStore('xattrs').index('by-ino').getAllKeys(ino)
		for (const k of xkeys) {
			await tx.objectStore('xattrs').delete(k)
		}
	}

	// ---------------------------------------------------------------------------
	// Capabilities
	// ---------------------------------------------------------------------------

	const caps: StorageCapabilities = {
		async getXattr(ino, name) {
			const db = await getDb()
			const rec = await db.get('xattrs', [ino, name])
			return rec ? rec.value.slice() : null
		},

		async setXattr(ino, name, value) {
			const db = await getDb()
			const tx = db.transaction(['xattrs'], 'readwrite')
			await tx.objectStore('xattrs').put({ ino, name, value: value.slice() })
			await tx.done
		},

		async listXattrs(ino) {
			const db = await getDb()
			const keys = await db.getAllKeysFromIndex('xattrs', 'by-ino', ino)
			return keys.map((k) => k[1])
		},

		async removeXattr(ino, name) {
			const db = await getDb()
			const tx = db.transaction(['xattrs'], 'readwrite')
			await tx.objectStore('xattrs').delete([ino, name])
			await tx.done
		},

		async atomicCreate(dirIno, name, meta, options) {
			const db = await getDb()
			const tx = db.transaction(['inodes', 'content', 'dirs'], 'readwrite')
			const existing = await tx.objectStore('dirs').get([dirIno, name])
			if (existing) {
				await tx.done
				throw new Error(`EEXIST: ${name}`)
			}
			const ino = crypto.randomUUID()
			const now = Date.now()
			await tx.objectStore('inodes').put({ ino, ...meta, lastAccessedAt: now })
			if (meta.type === FileType.Regular) {
				await tx
					.objectStore('content')
					.put({ ino, data: new Uint8Array(), sizeBytes: 0, lastAccessedAt: now })
			}
			await tx.objectStore('dirs').put({ dirIno, name, ino, type: meta.type })
			await tx.done
			emit({ ino, kind: 'meta', source: options?.source })
			emit({ ino, kind: 'dirent', dirIno, name, source: options?.source })
			return ino
		},

		async atomicMove(oldDir, oldName, newDir, newName, options) {
			const db = await getDb()
			const tx = db.transaction(
				['inodes', 'content', 'dirs', 'xattrs', 'dirty', 'meta'],
				'readwrite'
			)

			const source = await tx.objectStore('dirs').get([oldDir, oldName])
			if (!source) {
				await tx.done
				throw new Error(`ENOENT: ${oldName}`)
			}

			const destination = await tx.objectStore('dirs').get([newDir, newName])
			let displaced: Ino | null = null

			if (destination && destination.ino !== source.ino) {
				displaced = destination.ino
				await freeIno(tx as FullTx, destination.ino, destination.type)
				await tx.objectStore('dirs').delete([newDir, newName])
			}

			await tx.objectStore('dirs').delete([oldDir, oldName])
			await tx
				.objectStore('dirs')
				.put({ dirIno: newDir, name: newName, ino: source.ino, type: source.type })

			await tx.done
			if (displaced !== null) emit({ ino: displaced, kind: 'meta', source: options?.source })
			emit({
				ino: source.ino,
				kind: 'dirent',
				dirIno: newDir,
				name: newName,
				source: options?.source
			})
			emit({
				ino: source.ino,
				kind: 'dirent',
				dirIno: oldDir,
				name: oldName,
				source: options?.source
			})
			return displaced
		},

		async fullScan(cursor) {
			const db = await getDb()
			const inoToPath = new Map<Ino, string>([[ROOT_INO, '/']])
			const entries: import('./storage').ScanEntry[] = []

			// BFS walk
			const queue: Ino[] = [ROOT_INO]
			while (queue.length > 0) {
				const dirIno = queue.shift()
				if (dirIno === undefined) break
				let cur = cursor
				do {
					const lower: [string, string] = [dirIno, cur]
					const upper: [string, string] = [dirIno, '\uffff']
					const range = KeyRange.bound(lower, upper, cur !== '', false) as never
					const records = await db.getAll('dirs', range, DIR_PAGE + 1)
					const hasMore = records.length > DIR_PAGE
					const page = records.slice(0, DIR_PAGE)

					for (const r of page) {
						const dirPath = inoToPath.get(r.dirIno) ?? '/'
						const path = dirPath === '/' ? `/${r.name}` : `${dirPath}/${r.name}`
						inoToPath.set(r.ino, path)
						const meta = await db.get('inodes', r.ino)
						if (!meta) continue
						const xattrRecs = await db.getAllFromIndex('xattrs', 'by-ino', r.ino)
						const xattrs =
							xattrRecs.length > 0
								? Object.fromEntries(xattrRecs.map((x) => [x.name, x.value.slice()]))
								: undefined
						entries.push({
							ino: r.ino,
							dirIno: r.dirIno,
							name: r.name,
							meta: metaFromRecord(meta),
							...(xattrs ? { xattrs } : {})
						})
						if (r.type === FileType.Directory) queue.push(r.ino)
					}

					cur = hasMore ? (page[DIR_PAGE - 1]?.name ?? '') : ''
				} while (cur !== '')
				// Reset cursor after root (cursor only applies to root for pagination purposes)
				cursor = ''
			}

			return { entries, next: '' }
		},

		subscribe(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},

		// ── Path-sync seams (Phase 0: shape only) ────────────────────────────────
		journal: {
			async append(_changes, _localSource) {
				// TODO(path-sync): add rows to the `journal` object store in the mutation txn.
				throw new Error('not implemented')
			},
			async readFrom(_seq, _limit) {
				// TODO(path-sync): openCursor(lowerBound(seq, open)), take limit.
				throw new Error('not implemented')
			},
			async head() {
				// TODO(path-sync): openCursor(null, 'prev').key ?? 0.
				throw new Error('not implemented')
			}
		},
		pathApply: {
			async localChange(_path) {
				// TODO(path-sync): read path_version + reconstruct the path's current
				// PathChange (put/delete) for the engine's LWW compare.
				throw new Error('not implemented')
			},
			async applyJournaled(_changes, _opts) {
				// TODO(path-sync): tree meta + contentHash ref + journal row + path_version.
				throw new Error('not implemented')
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Storage implementation
	// ---------------------------------------------------------------------------

	return {
		rootIno: ROOT_INO,
		caps,

		destroy() {
			dbPromise?.then((db) => db.close()).catch(() => {})
			dbPromise = null
		},

		async getMeta(ino) {
			const db = await getDb()
			const rec = await db.get('inodes', ino)
			if (!rec) return null
			return metaFromRecord(rec)
		},

		async setMeta(ino, partial, options) {
			const db = await getDb()
			const tx = db.transaction(['inodes', 'content'], 'readwrite')
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
						lastAccessedAt: next.lastAccessedAt
					})
				}
				await tx.done
				emit({ ino, kind: 'meta', source: options?.source })
				return
			}
			const next = { ...rec, ...partial }
			await tx.objectStore('inodes').put(next)
			await tx.done
			emit({ ino, kind: 'meta', source: options?.source })
		},

		async deleteInode(ino) {
			const db = await getDb()
			const inode = await db.get('inodes', ino)
			if (!inode) return
			if (await hasDirentReference(db, ino)) return
			const tx = db.transaction(['inodes', 'content', 'xattrs', 'dirty', 'meta'], 'readwrite')
			await tx.objectStore('inodes').delete(ino)
			await tx.objectStore('dirty').delete(ino)

			if (inode.type === FileType.Regular) {
				const rec = await tx.objectStore('content').get(ino)
				if (rec) {
					const total =
						((await tx.objectStore('meta').get('totalContentBytes')) as number | undefined) ?? 0
					await tx.objectStore('meta').put(Math.max(0, total - rec.sizeBytes), 'totalContentBytes')
					await tx.objectStore('content').delete(ino)
				}
			}

			const xkeys = await tx.objectStore('xattrs').index('by-ino').getAllKeys(ino)
			for (const k of xkeys) {
				await tx.objectStore('xattrs').delete(k)
			}
			await tx.done
			emit({ ino, kind: 'meta' })
		},

		async getBlob(ino) {
			const db = await getDb()
			const tx = db.transaction(['content'], 'readwrite')
			const rec = await tx.objectStore('content').get(ino)
			if (!rec) {
				await tx.done
				return new Uint8Array()
			}
			await tx.objectStore('content').put({ ...rec, lastAccessedAt: Date.now() })
			await tx.done
			return rec.data.slice()
		},

		async putBlob(ino, data, options) {
			const db = await getDb()
			const existing = await db.get('content', ino)
			const oldSize = existing?.sizeBytes ?? 0
			const delta = data.length - oldSize
			if (delta > 0) await evictContent(db, delta, ino)
			await writeContent(db, ino, data.slice(), oldSize)
			emit({ ino, kind: 'content', source: options?.source })
		},

		async getDirent(dirIno, name) {
			const db = await getDb()
			const rec = await db.get('dirs', [dirIno, name])
			return rec ? { ino: rec.ino, type: rec.type } : null
		},

		async putDirent(dirIno, name, entry, options) {
			const db = await getDb()
			const tx = db.transaction(['dirs'], 'readwrite')
			await tx.objectStore('dirs').put({ dirIno, name, ino: entry.ino, type: entry.type })
			await tx.done
			emit({ ino: entry.ino, kind: 'dirent', dirIno, name, source: options?.source })
		},

		async deleteDirent(dirIno, name, options) {
			const db = await getDb()
			const tx = db.transaction(['dirs'], 'readwrite')
			const existing = await tx.objectStore('dirs').get([dirIno, name])
			if (!existing) {
				await tx.done
				return
			}
			await tx.objectStore('dirs').delete([dirIno, name])
			await tx.done
			emit({ ino: existing.ino, kind: 'dirent', dirIno, name, source: options?.source })
		},

		async listDirents(dirIno, cursor) {
			const db = await getDb()
			const lower: [string, string] = [dirIno, cursor]
			const upper: [string, string] = [dirIno, '\uffff']
			const range = KeyRange.bound(lower, upper, cursor !== '', false) as never

			const records = await db.getAll('dirs', range, DIR_PAGE + 1)
			const hasMore = records.length > DIR_PAGE
			const page = records.slice(0, DIR_PAGE)

			return {
				entries: page.map((r) => ({ name: r.name, ino: r.ino, type: r.type })),
				next: hasMore ? (page[DIR_PAGE - 1]?.name ?? '') : ''
			}
		}
	}
}
