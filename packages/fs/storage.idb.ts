import type { DBSchema, IDBPDatabase, IDBPObjectStore, IDBPTransaction, StoreNames } from 'idb'
import { openDB } from 'idb'
import type { InodeMeta, Storage, StorageCapabilities, StorageChange } from './storage'
import type { PathStorePort } from './storage.shared'
import { applyJournaledOver, joinPath, localChangeOver, pathSyncObserver } from './storage.shared'
import type { JournalRow } from './sync-replica'
import { coalesceByPath, inodeMetaFromSync, type PathChange } from './sync-wire'
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
	contentHash: string
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

interface JournalRecord {
	seq?: number
	change: PathChange
	localSource?: string
}

interface PathVerRecord {
	path: string
	version: number
	tombstone: number
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
		indexes: { 'by-dir': string; 'by-ino': string }
	}
	xattrs: {
		key: [string, string]
		value: XattrRecord
		indexes: { 'by-ino': string }
	}
	dirty: { key: string; value: DirtyRecord }
	meta: { key: string; value: unknown }
	journal: {
		key: number
		value: JournalRecord
		indexes: { 'by-path': string }
	}
	pathver: { key: string; value: PathVerRecord }
}

type Db = IDBPDatabase<GhostoreFsSchema>
type AllStores = (
	| 'inodes'
	| 'content'
	| 'dirs'
	| 'xattrs'
	| 'dirty'
	| 'meta'
	| 'journal'
	| 'pathver'
)[]
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

const DB_VERSION = 6
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

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

type JournalStoreOf<Mode extends 'readwrite' | 'versionchange'> = IDBPObjectStore<
	GhostoreFsSchema,
	ArrayLike<StoreNames<GhostoreFsSchema>>,
	'journal',
	Mode
>

/**
 * Append a journal row, and take out the rows it supersedes.
 *
 * AT MOST ONE ROW PER PATH, always — the invariant the SQLite backend holds by the
 * same rule (#446). Here it is what keeps the journal bounded at all: nothing on
 * the device collects it (`gcUnreferenced` runs in the Durable Object, against the
 * other backend), so an append-only journal gives every browser profile a floor
 * that only rises (#439).
 *
 * One row per path is also the FLOOR, not a target to go under: this backend serves
 * no tree snapshot, so a bootstrapping peer is answered by replaying the journal
 * (`snapshotPutsUpTo`), and the latest row per path is exactly that answer.
 *
 * Add first, then delete below the key `add` returns — that key is the exact cut,
 * so nothing has to go looking for the maximum. Every row this removes has a
 * higher-seq successor on the same path, so a reader resuming at ANY seq still
 * converges, and this backend needs no `prunedBelow` floor.
 */
async function appendJournalRow(
	journal: JournalStoreOf<'readwrite'>,
	change: PathChange,
	localSource?: string
): Promise<void> {
	const seq = await journal.add({ change, localSource })
	let cursor = await journal.index('by-path').openCursor(change.path)
	while (cursor && cursor.primaryKey < seq) {
		await cursor.delete()
		cursor = await cursor.continue()
	}
}

/**
 * Collapse existing history to one row per path — the one-time counterpart of the
 * rule above, for a profile that filled its journal before this version.
 *
 * Runs in the version-change transaction, so it runs once and holds the database
 * alone. Without it the backlog would only drain a path at a time, as each path is
 * next written, and a path never written again would keep its rows forever.
 */
async function coalesceJournal(journal: JournalStoreOf<'versionchange'>): Promise<void> {
	const latest = new Map<string, number>()
	let cursor = await journal.openCursor()
	while (cursor) {
		latest.set(cursor.value.change.path, cursor.key)
		cursor = await cursor.continue()
	}
	cursor = await journal.openCursor()
	while (cursor) {
		if (latest.get(cursor.value.change.path) !== cursor.key) await cursor.delete()
		cursor = await cursor.continue()
	}
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
 * Uses eight object stores:
 *   inodes   — inode metadata (no nlink)
 *   content  — file data, HASH-addressed by contentHash (dedup + blob-by-hash
 *              sync), subject to LRU eviction up to contentCapBytes
 *   dirs     — directory entries keyed by [dirIno, name]; by-ino reverse index
 *   xattrs   — extended attributes keyed by [ino, name]
 *   dirty    — inodes with unflushed local writes (protected from LRU eviction)
 *   meta     — key-value bootstrap state (rootIno, totalContentBytes, etc.)
 *   journal  — path-stamped change log, ONE row per path (outbound sync source of
 *              truth, and the snapshot a bootstrapping peer is replayed)
 *   pathver  — per-path { version, tombstone } scalars
 *
 * The root inode is always '1' (matching the memStorage convention).
 */
export function idbStorage(
	dbName: string,
	options?: { contentCapBytes?: number; localActorId?: string }
): IdbStorage {
	const cap = options?.contentCapBytes ?? DEFAULT_CONTENT_CAP
	// The backend's client-id, stamped as ORIGIN (PathChange.source) on local writes.
	const localActorId = options?.localActorId ?? 'local'
	// The filesystem announces its tree writes here; this module decides what to
	// record (storage.shared.ts ROADMAP item 3 / #454). Attached unconditionally for
	// now — inverting the construction is a later slice.
	const observer = pathSyncObserver(localActorId)
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
				async upgrade(db, oldVersion, _newVersion, transaction) {
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
					if (oldVersion < 5) {
						// Content becomes HASH-addressed (dedup + blob-by-hash sync). Recreate
						// the store keyed by contentHash; cached local bytes re-materialise via
						// sync (matching the inodes recreation above).
						if (db.objectStoreNames.contains('content')) db.deleteObjectStore('content')
						const content = db.createObjectStore('content', { keyPath: 'contentHash' })
						content.createIndex('by-lru', 'lastAccessedAt')
						// pathOf(ino) walks UP the tree via a reverse dirent index.
						const dirs = transaction.objectStore('dirs')
						if (!dirs.indexNames.contains('by-ino')) dirs.createIndex('by-ino', 'ino')
						// Path journal (outbound sync source of truth) + per-path version scalars.
						db.createObjectStore('journal', { keyPath: 'seq', autoIncrement: true })
						db.createObjectStore('pathver', { keyPath: 'path' })
					}
					if (oldVersion < 6) {
						// The journal keeps ONE row per path from here on (see appendJournalRow),
						// which needs an index to find the superseded rows without a full scan.
						const journal = transaction.objectStore('journal')
						if (!journal.indexNames.contains('by-path'))
							journal.createIndex('by-path', 'change.path')
						// Rows written before that rule are collapsed once, here. Awaiting only IDB
						// requests keeps this version-change transaction alive to the end of it.
						await coalesceJournal(journal)
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

	async function evictContent(db: Db, addingBytes: number, keepHash: string): Promise<void> {
		const total = ((await db.get('meta', 'totalContentBytes')) as number | undefined) ?? 0
		if (total + addingBytes <= cap) return

		const tx = db.transaction(['content', 'dirty', 'inodes', 'meta'], 'readwrite')
		// Never evict content still referenced by a DIRTY (unsynced) inode — those
		// bytes cannot be re-fetched. Synced/pulled content is safely re-fetchable.
		const dirtyHashes = new Set<string>()
		for (const ino of await tx.objectStore('dirty').getAllKeys()) {
			const inode = await tx.objectStore('inodes').get(ino)
			if (inode?.contentHash) dirtyHashes.add(inode.contentHash)
		}

		let running = total
		let cursor = await tx.objectStore('content').index('by-lru').openCursor()
		while (cursor && running + addingBytes > cap) {
			const { contentHash, sizeBytes } = cursor.value
			if (contentHash !== keepHash && !dirtyHashes.has(contentHash)) {
				running -= sizeBytes
				await cursor.delete()
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
	 * Store content HASH-addressed (dedup): the first writer of a hash pays the
	 * bytes, later references just bump LRU. Caller must call evictContent first.
	 */
	async function storeContentByHashTx(tx: FullTx, hash: string, data: Uint8Array): Promise<void> {
		const now = Date.now()
		const existing = await tx.objectStore('content').get(hash)
		if (existing) {
			await tx.objectStore('content').put({ ...existing, lastAccessedAt: now })
			return
		}
		await tx
			.objectStore('content')
			.put({ contentHash: hash, data, sizeBytes: data.length, lastAccessedAt: now })
		const total =
			((await tx.objectStore('meta').get('totalContentBytes')) as number | undefined) ?? 0
		await tx.objectStore('meta').put(total + data.length, 'totalContentBytes')
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

	async function freeIno(tx: FullTx, ino: Ino): Promise<void> {
		// Free tree metadata + xattrs, but NOT blob content: content is hash-addressed
		// and may be shared / re-referenced (orphans reclaimed by eviction / GC).
		await tx.objectStore('inodes').delete(ino)
		await tx.objectStore('dirty').delete(ino)

		const xkeys = await tx.objectStore('xattrs').index('by-ino').getAllKeys(ino)
		for (const k of xkeys) {
			await tx.objectStore('xattrs').delete(k)
		}
	}

	// ---------------------------------------------------------------------------
	// Path-sync helpers (per-backend: pathOf walk-up, tree ops, apply port)
	// ---------------------------------------------------------------------------

	/** Resolve ino -> canonical path by walking UP the by-ino dirent index; null if unlinked. */
	async function pathOfTx(tx: FullTx, ino: Ino): Promise<string | null> {
		if (ino === ROOT_INO) return '/'
		const segs: string[] = []
		let cur: Ino = ino
		while (cur !== ROOT_INO) {
			const dirent = await tx.objectStore('dirs').index('by-ino').get(cur)
			if (!dirent) return null
			segs.unshift(dirent.name)
			cur = dirent.dirIno
		}
		return `/${segs.join('/')}`
	}

	/** Resolve a canonical path to an ino by walking dirents; null if absent. */
	async function resolveInoTx(tx: FullTx, path: string): Promise<Ino | null> {
		if (path === '/') return ROOT_INO
		let cur: Ino = ROOT_INO
		for (const seg of path.slice(1).split('/')) {
			const dirent = await tx.objectStore('dirs').get([cur, seg])
			if (!dirent) return null
			cur = dirent.ino
		}
		return cur
	}

	/** Ensure every segment of a directory path exists (tree repair); return the deepest ino. */
	async function ensureDirPathTx(tx: FullTx, path: string): Promise<Ino> {
		if (path === '/') return ROOT_INO
		let cur: Ino = ROOT_INO
		for (const seg of path.slice(1).split('/')) {
			const dirent = await tx.objectStore('dirs').get([cur, seg])
			if (dirent) {
				cur = dirent.ino
				continue
			}
			const ino = crypto.randomUUID()
			const stamp = BigInt(Date.now()) * 1_000_000n
			await tx.objectStore('inodes').put({
				ino,
				type: FileType.Directory,
				size: 0n,
				mode: 0o755,
				mtimeNs: stamp,
				ctimeNs: stamp,
				lastAccessedAt: Date.now()
			})
			await tx.objectStore('dirs').put({ dirIno: cur, name: seg, ino, type: FileType.Directory })
			cur = ino
		}
		return cur
	}

	/** All paths in the subtree rooted at `ino`, as { ino, rel } (root rel = ''). */
	async function enumerateSubtreeTx(tx: FullTx, ino: Ino): Promise<{ ino: Ino; rel: string }[]> {
		const out: { ino: Ino; rel: string }[] = [{ ino, rel: '' }]
		const children = await tx.objectStore('dirs').index('by-dir').getAll(ino)
		for (const child of children) {
			for (const d of await enumerateSubtreeTx(tx, child.ino))
				out.push({ ino: d.ino, rel: `/${child.name}${d.rel}` })
		}
		return out
	}

	/** Install a remote put's tree metadata + contentHash REFERENCE; replace user xattrs. */
	async function upsertInodeFromSyncTx(tx: FullTx, ino: Ino, change: PathChange): Promise<void> {
		if (change.kind !== 'put') return
		const { meta, xattrs: snapshot } = inodeMetaFromSync(change.meta)
		const type = meta.type ?? FileType.Regular
		const existing = await tx.objectStore('inodes').get(ino)
		await tx.objectStore('inodes').put({
			ino,
			type,
			size: meta.size ?? 0n,
			mode: meta.mode ?? defaultModeForType(type),
			mtimeNs: meta.mtimeNs ?? 0n,
			ctimeNs: 0n, // ctime is set locally at apply time, never wired
			contentHash: change.contentHash,
			symlinkTarget: meta.symlinkTarget,
			lastAccessedAt: existing?.lastAccessedAt ?? Date.now()
		})
		// Replace the whole USER-xattr set with the snapshot; keep trusted.sync.*.
		const xrecs = await tx.objectStore('xattrs').index('by-ino').getAll(ino)
		for (const x of xrecs)
			if (!x.name.startsWith('trusted.sync.')) await tx.objectStore('xattrs').delete([ino, x.name])
		for (const [name, value] of Object.entries(snapshot))
			await tx.objectStore('xattrs').put({ ino, name, value })
	}

	// The storage-independent seam the shared apply driver + the mutation observer
	// (storage.shared.ts) call, bound to one transaction. `emit` is buffered so
	// applyJournaled can flush AFTER the txn commits (idb fires change events
	// post-commit).
	function makePathPort(tx: FullTx): { port: PathStorePort; emits: StorageChange[] } {
		const emits: StorageChange[] = []
		const port: PathStorePort = {
			mintIno: () => crypto.randomUUID(),
			resolveIno: (path) => resolveInoTx(tx, path),
			pathOf: (ino) => pathOfTx(tx, ino),
			enumerateSubtree: (ino) => enumerateSubtreeTx(tx, ino),
			ensureDirPath: (path) => ensureDirPathTx(tx, path),
			async getDirent(dirIno, name) {
				const d = await tx.objectStore('dirs').get([dirIno, name])
				return d ? { ino: d.ino, type: d.type } : null
			},
			async readMetaXattrs(ino) {
				const rec = await tx.objectStore('inodes').get(ino)
				if (!rec) return null
				const xrecs = await tx.objectStore('xattrs').index('by-ino').getAll(ino)
				const xattrs = Object.fromEntries(xrecs.map((x) => [x.name, x.value.slice()]))
				return { meta: metaFromRecord(rec), xattrs }
			},
			upsertInodeFromSync: (ino, change) => upsertInodeFromSyncTx(tx, ino, change),
			async setDirent(dirIno, name, ino, type) {
				await tx.objectStore('dirs').put({ dirIno, name, ino, type })
			},
			async deleteDirent(dirIno, name) {
				await tx.objectStore('dirs').delete([dirIno, name])
			},
			async deleteInodeIfUnreferenced(ino) {
				// NEVER GC blob content: a later put in the batch may re-reference the hash.
				const ref = await tx.objectStore('dirs').index('by-ino').get(ino)
				if (ref) return
				await tx.objectStore('inodes').delete(ino)
				const xkeys = await tx.objectStore('xattrs').index('by-ino').getAllKeys(ino)
				for (const k of xkeys) await tx.objectStore('xattrs').delete(k)
			},
			async dirHasLiveChildren(ino) {
				const child = await tx.objectStore('dirs').index('by-dir').get(ino)
				return child !== undefined
			},
			async readPathVersion(path) {
				const rec = await tx.objectStore('pathver').get(path)
				return { version: rec?.version ?? 0, tombstone: rec?.tombstone ?? 0 }
			},
			async setPathVersion(path, version, tombstone) {
				await tx.objectStore('pathver').put({ path, version, tombstone })
			},
			async appendJournalRow(change, localSource) {
				await appendJournalRow(tx.objectStore('journal'), change, localSource)
			},
			emit(change) {
				emits.push(change)
			}
		}
		return { port, emits }
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

		// `content` (see storage.ts) is never passed to this backend: it has a
		// hash-addressed content store, so the VFS publishes the bytes under their hash
		// first and this claim carries the reference in `meta.contentHash`.
		async atomicCreate(dirIno, name, meta, content, options) {
			const db = await getDb()
			// Hashed and space-made BEFORE the transaction opens: neither can happen inside
			// one (an IDB txn auto-closes over a non-IDB await), and neither COMMITS
			// anything, so a claim lost below leaves nothing staged.
			let stored = meta
			let blob: [string, Uint8Array] | undefined
			if (content !== undefined) {
				const bytes = content.slice()
				const hash = await sha256Hex(bytes)
				await evictContent(db, bytes.length, hash)
				stored = { ...meta, size: BigInt(bytes.length), contentHash: hash }
				blob = [hash, bytes]
			}
			// 'content' and 'meta' join the claim's OWN transaction (#323) — the same set
			// `putBlob` uses, since `storeContentByHashTx` maintains the total-bytes counter
			// in 'meta'. Staging the blob in a separate, earlier transaction left it committed
			// with ZERO inode references, where a `gcUnreferenced()` sweep reclaims it —
			// correctly — and the claim then publishes a `contentHash` pointing at nothing.
			const tx = db.transaction(
				['inodes', 'dirs', 'xattrs', 'pathver', 'journal', 'dirty', 'content', 'meta'],
				'readwrite'
			) as FullTx
			const existing = await tx.objectStore('dirs').get([dirIno, name])
			if (existing) {
				await tx.done
				throw new Error(`EEXIST: ${name}`)
			}
			const ino = crypto.randomUUID()
			const now = Date.now()
			if (blob) await storeContentByHashTx(tx, blob[0], blob[1])
			await tx.objectStore('inodes').put({ ino, ...stored, lastAccessedAt: now })
			await tx.objectStore('dirs').put({ dirIno, name, ino, type: stored.type })
			// A create that already carries a contentHash (write-then-publish — see
			// volume.ts's writeFile) is a content-bearing LOCAL write, exactly like an
			// in-place edit through putBlob — mark it dirty here, in the SAME
			// transaction, or evictContent's "never reclaim a dirty inode's bytes"
			// guarantee never applies to a freshly created file, and a later write's
			// eviction sweep can silently drop its unsynced content. Sync-pulled
			// creates never reach this function (they go through
			// upsertInodeFromSyncTx, which correctly never marks dirty — pulled
			// content is safely re-fetchable), so this can't misfire on remote writes.
			if (stored.contentHash) {
				await tx.objectStore('dirty').put({ ino, markedAt: now })
			}
			const dirPath = await pathOfTx(tx, dirIno)
			await observer.record(
				makePathPort(tx).port,
				{ kind: 'link', dirIno, name, ino, type: stored.type },
				options
			)
			await tx.done
			emit({ ino, kind: 'meta', source: options?.source })
			emit({
				ino,
				kind: 'dirent',
				dirIno,
				name,
				path: dirPath === null ? undefined : joinPath(dirPath, name),
				source: options?.source
			})
			return ino
		},

		async atomicMove(oldDir, oldName, newDir, newName, options) {
			const db = await getDb()
			const tx = db.transaction(
				['inodes', 'content', 'dirs', 'xattrs', 'dirty', 'meta', 'pathver', 'journal'],
				'readwrite'
			) as FullTx

			const source = await tx.objectStore('dirs').get([oldDir, oldName])
			if (!source) {
				await tx.done
				throw new Error(`ENOENT: ${oldName}`)
			}
			const oldDirPath = await pathOfTx(tx, oldDir)
			const newDirPath = await pathOfTx(tx, newDir)
			if (oldDirPath === null || newDirPath === null) {
				await tx.done
				throw new Error('ENOENT: parent')
			}
			const oldBase = joinPath(oldDirPath, oldName)
			const newBase = joinPath(newDirPath, newName)

			const destination = await tx.objectStore('dirs').get([newDir, newName])
			let displaced: Ino | null = null

			if (destination && destination.ino !== source.ino) {
				displaced = destination.ino
				// Unbind the name FIRST, then free the inode only if nothing else still names it
				// — `Storage.deleteInode`'s rule, which this path used to skip. The order is the
				// whole trick: asked before the delete, the check would find the very entry being
				// replaced and never free anything (an inode leaked per replace); asked after, it
				// sees only OTHER names. Sync replay legitimately leaves a transient second one
				// during a move, and freeing a still-named inode leaves that survivor pointing at
				// nothing. Same shape as memStorage's `hasDirentReference` guard.
				await tx.objectStore('dirs').delete([newDir, newName])
				const alsoNamed = await tx.objectStore('dirs').index('by-ino').get(destination.ino)
				if (alsoNamed === undefined) await freeIno(tx, destination.ino)
			}

			await tx.objectStore('dirs').delete([oldDir, oldName])
			await tx
				.objectStore('dirs')
				.put({ dirIno: newDir, name: newName, ino: source.ino, type: source.type })

			// ONE effect, however big the subtree is — what recording it costs is the
			// observer's call, not this backend's.
			await observer.record(
				makePathPort(tx).port,
				{
					kind: 'move',
					fromDirIno: oldDir,
					fromName: oldName,
					toDirIno: newDir,
					toName: newName,
					ino: source.ino,
					displaced
				},
				options
			)

			await tx.done
			if (displaced !== null) emit({ ino: displaced, kind: 'meta', source: options?.source })
			emit({
				ino: source.ino,
				kind: 'dirent',
				dirIno: newDir,
				name: newName,
				path: newBase,
				source: options?.source
			})
			emit({
				ino: source.ino,
				kind: 'dirent',
				dirIno: oldDir,
				name: oldName,
				path: oldBase,
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

		// Drop local sync state (journal + version generator) for a client reset —
		// see StorageCapabilities.clearSyncState. Tree + content are left intact.
		async clearSyncState() {
			const db = await getDb()
			const tx = db.transaction(['journal', 'pathver'], 'readwrite')
			await tx.objectStore('journal').clear()
			await tx.objectStore('pathver').clear()
			await tx.done
		},

		journal: {
			async append(changes, localSource) {
				const db = await getDb()
				const tx = db.transaction(['journal'], 'readwrite')
				const journal = tx.objectStore('journal')
				for (const change of changes) await appendJournalRow(journal, change, localSource)
				await tx.done
			},
			async readFrom(seq, limit) {
				const db = await getDb()
				const out: JournalRow[] = []
				let cursor = await db
					.transaction('journal')
					.objectStore('journal')
					.openCursor(KeyRange.lowerBound(seq + 1) as never)
				while (cursor && out.length < limit) {
					out.push({
						seq: cursor.key,
						change: cursor.value.change,
						localSource: cursor.value.localSource
					})
					cursor = await cursor.continue()
				}
				return out
			},
			async head() {
				const db = await getDb()
				const cursor = await db
					.transaction('journal')
					.objectStore('journal')
					.openCursor(null, 'prev')
				return cursor ? cursor.key : 0
			},
			// Replace history with one locally-authored latest row per path.
			async adoptAllAsLocal(opts) {
				const db = await getDb()
				const tx = db.transaction(['journal'], 'readwrite')
				const journal = tx.objectStore('journal')
				const current = coalesceByPath((await journal.getAll()).map((row) => row.change)).filter(
					(change) => !opts?.dropDeletes || change.kind === 'put'
				)
				await journal.clear()
				// A plain add: the store is empty and `current` already holds one row per
				// path, so there is nothing for appendJournalRow to supersede.
				for (const change of current) await journal.add({ change })
				await tx.done
			}
		},
		content: {
			async getByHash(hash) {
				const db = await getDb()
				const rec = await db.get('content', hash)
				return rec ? rec.data.slice() : null
			},
			async hasByHash(hash) {
				const db = await getDb()
				return (await db.getKey('content', hash)) !== undefined
			},
			async putByHash(hash, data) {
				const db = await getDb()
				const bytes = data.slice()
				await evictContent(db, bytes.length, hash)
				const tx = db.transaction(['content', 'meta'], 'readwrite') as FullTx
				await storeContentByHashTx(tx, hash, bytes)
				await tx.done
			},
			// Content only. The journal compacts itself on the write path (see
			// appendJournalRow), so this has no journal pass to run — which matters,
			// because on a browser NOTHING calls this: the daily sweep runs in the
			// Durable Object, against the SQLite backend.
			async gcUnreferenced() {
				const db = await getDb()
				const tx = db.transaction(['content', 'inodes', 'meta'], 'readwrite') as FullTx
				const live = new Set<string>()
				for (const inode of await tx.objectStore('inodes').getAll())
					if (inode.contentHash) live.add(inode.contentHash)
				let reclaimed = 0
				let freed = 0
				let cursor = await tx.objectStore('content').openCursor()
				while (cursor) {
					if (!live.has(cursor.value.contentHash)) {
						freed += cursor.value.sizeBytes
						await cursor.delete()
						reclaimed++
					}
					cursor = await cursor.continue()
				}
				if (freed > 0) {
					const total =
						((await tx.objectStore('meta').get('totalContentBytes')) as number | undefined) ?? 0
					await tx.objectStore('meta').put(Math.max(0, total - freed), 'totalContentBytes')
				}
				await tx.done
				// The whole prune runs in one IndexedDB transaction, so it always drains.
				return { reclaimed, done: true }
			}
		},
		pathApply: {
			async localChange(path) {
				const db = await getDb()
				// Reads only; the port needs a readwrite-typed tx but writes nothing here.
				const tx = db.transaction(['dirs', 'inodes', 'xattrs', 'pathver'], 'readwrite') as FullTx
				const change = await localChangeOver(makePathPort(tx).port, path, localActorId)
				await tx.done
				return change
			},
			async applyJournaled(changes, opts) {
				const db = await getDb()
				const tx = db.transaction(
					['dirs', 'inodes', 'xattrs', 'pathver', 'journal'],
					'readwrite'
				) as FullTx
				const bound = makePathPort(tx)
				await applyJournaledOver(bound.port, changes, opts)
				await tx.done
				// emit AFTER commit so a volume over idb invalidates its cache on the pull.
				for (const change of bound.emits) emit(change)
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
			const tx = db.transaction(
				['inodes', 'dirs', 'xattrs', 'pathver', 'journal'],
				'readwrite'
			) as FullTx
			const rec = await tx.objectStore('inodes').get(ino)
			if (!rec) {
				// Unlinked inode (createNode's setMeta before putDirent) — no path to journal.
				const next = buildMissingInodeRecord(ino, partial)
				if (!next) {
					await tx.done
					return
				}
				await tx.objectStore('inodes').put(next)
				await tx.done
				emit({ ino, kind: 'meta', source: options?.source })
				return
			}
			await tx.objectStore('inodes').put({ ...rec, ...partial })
			await observer.record(makePathPort(tx).port, { kind: 'meta', ino }, options)
			await tx.done
			emit({ ino, kind: 'meta', source: options?.source })
		},

		async deleteInode(ino) {
			const db = await getDb()
			const inode = await db.get('inodes', ino)
			if (!inode) return
			if (await hasDirentReference(db, ino)) return
			// Content is hash-addressed and shared; leave the blob for eviction / GC.
			const tx = db.transaction(['inodes', 'xattrs', 'dirty'], 'readwrite')
			await tx.objectStore('inodes').delete(ino)
			await tx.objectStore('dirty').delete(ino)
			const xkeys = await tx.objectStore('xattrs').index('by-ino').getAllKeys(ino)
			for (const k of xkeys) {
				await tx.objectStore('xattrs').delete(k)
			}
			await tx.done
			emit({ ino, kind: 'meta' })
		},

		async getBlob(ino) {
			const db = await getDb()
			const hash = (await db.get('inodes', ino))?.contentHash
			if (!hash) return new Uint8Array()
			const tx = db.transaction(['content'], 'readwrite')
			const rec = await tx.objectStore('content').get(hash)
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
			const bytes = data.slice()
			const hash = await sha256Hex(bytes)
			await evictContent(db, bytes.length, hash)
			const tx = db.transaction(
				['content', 'inodes', 'dirty', 'meta', 'dirs', 'xattrs', 'pathver', 'journal'],
				'readwrite'
			) as FullTx
			// Read the inode FIRST, in the transaction that will write: a deleted inode must
			// fail the write rather than leave its content behind as an orphan.
			const inode = await tx.objectStore('inodes').get(ino)
			if (!inode) {
				await tx.done
				throw new Error(`ENOENT: ino ${ino}`)
			}
			await storeContentByHashTx(tx, hash, bytes)
			// A write moves mtime and ctime (POSIX, and what the SQLite backend does),
			// stamped before the effect is announced so the new time ships with it.
			const stamp = BigInt(Date.now()) * 1_000_000n
			await tx.objectStore('inodes').put({
				...inode,
				size: BigInt(bytes.length),
				contentHash: hash,
				mtimeNs: stamp,
				ctimeNs: stamp
			})
			await tx.objectStore('dirty').put({ ino, markedAt: Date.now() })
			await observer.record(
				makePathPort(tx).port,
				{ kind: 'content', ino, contentHash: hash },
				options
			)
			await tx.done
			emit({ ino, kind: 'content', source: options?.source })
		},

		async getDirent(dirIno, name) {
			const db = await getDb()
			const rec = await db.get('dirs', [dirIno, name])
			return rec ? { ino: rec.ino, type: rec.type } : null
		},

		async putDirent(dirIno, name, entry, options) {
			const db = await getDb()
			const tx = db.transaction(
				['dirs', 'inodes', 'xattrs', 'pathver', 'journal'],
				'readwrite'
			) as FullTx
			await tx.objectStore('dirs').put({ dirIno, name, ino: entry.ino, type: entry.type })
			const dirPath = await pathOfTx(tx, dirIno)
			await observer.record(
				makePathPort(tx).port,
				{ kind: 'link', dirIno, name, ino: entry.ino, type: entry.type },
				options
			)
			await tx.done
			emit({
				ino: entry.ino,
				kind: 'dirent',
				dirIno,
				name,
				path: dirPath === null ? undefined : joinPath(dirPath, name),
				source: options?.source
			})
		},

		async deleteDirent(dirIno, name, options) {
			const db = await getDb()
			const tx = db.transaction(
				['dirs', 'inodes', 'xattrs', 'pathver', 'journal'],
				'readwrite'
			) as FullTx
			const existing = await tx.objectStore('dirs').get([dirIno, name])
			if (!existing) {
				await tx.done
				return
			}
			const dirPath = await pathOfTx(tx, dirIno)
			await tx.objectStore('dirs').delete([dirIno, name])
			await observer.record(
				makePathPort(tx).port,
				{ kind: 'unlink', dirIno, name, ino: existing.ino },
				options
			)
			await tx.done
			emit({
				ino: existing.ino,
				kind: 'dirent',
				dirIno,
				name,
				path: dirPath === null ? undefined : joinPath(dirPath, name),
				source: options?.source
			})
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

/**
 * Ask the browser to keep this origin's storage, and report whether it will.
 *
 * Without this, everything a volume holds is "best-effort": the browser may
 * evict it under storage pressure, and Safari deletes script-written storage
 * after seven days of browser use with no interaction on the site. Eviction is
 * ALL-OR-NOTHING per origin — IndexedDB and the Cache API go together — so for
 * a local-first app whose volume does not sync anywhere, it is silent and total
 * data loss rather than a cold cache.
 *
 * What it is worth differs by browser, and none of it is a guarantee. Firefox
 * prompts. Chrome and Safari decide silently from engagement, so a first visit
 * is usually refused and a later one may not be — which is why this asks again
 * on every call rather than remembering a refusal. Safari's seven-day cap has
 * no documented exemption other than installing to the home screen, so this
 * complements a web app manifest rather than replacing one.
 *
 * `false` is an answer, not a failure. A host that promises local-first should
 * treat it as a reason to offer sync or an export, not swallow it.
 */
export async function persistStorage(): Promise<boolean> {
	const storage = globalThis.navigator?.storage
	if (!storage?.persist) return false
	try {
		// Asking again when it has already been granted would re-prompt on Firefox.
		return (await storage.persisted()) || (await storage.persist())
	} catch {
		return false
	}
}
