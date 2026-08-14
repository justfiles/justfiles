import type {
	InodeMeta,
	MutationOptions,
	StorageCapabilities,
	StorageChange
} from '@justfiles/fs/storage'
import type { TreeEffect, TreePort } from '@justfiles/fs/storage.shared'
import { joinPath } from '@justfiles/fs/storage.shared'
import type { Ino } from '@justfiles/fs/types'
import { FileType } from '@justfiles/fs/types'
import {
	applyNodeOperationsOver,
	compactNodeJournal,
	createSyncCapability,
	type NodeJournalRow,
	NodeOperation,
	type NodeState,
	type NodeStore,
	type NodeSyncModule,
	nodeSnapshotEntries,
	nodeSyncObserver,
	type SyncCapableStorage,
	withSyncCapability
} from '@justfiles/sync/node'
import {
	applyJournaledOver,
	buildDeleteChange,
	buildPutChange,
	localChangeOver,
	type PathSyncStore,
	pathSyncObserver
} from '@justfiles/sync/path'
import type { JournaledStorage, JournaledSyncModule } from '@justfiles/sync/replica'
import { coalesceByPath, type PathChange } from '@justfiles/sync/wire'
import type { DbAdapter } from './db'

type BlobObject = {
	arrayBuffer(): Promise<ArrayBuffer>
}

type BlobStore = {
	put(
		key: string,
		value: ArrayBuffer | ArrayBufferView | string | Blob,
		options?: {
			httpMetadata?: { contentType?: string }
			customMetadata?: Record<string, string>
		}
	): Promise<unknown>
	get(key: string): Promise<BlobObject | null>
	/** One key or a batch — R2's own signature, so a sweep costs one round trip per 1000. */
	delete?(keys: string | string[]): Promise<void>
}

type StorageOptions = {
	blobStore?: BlobStore
	namespace?: string
	inlineTextLimitBytes?: number
	/** Default origin for local writes without an explicit `options.origin`. */
	localActorId?: string
}

type InodeRow = {
	ino: unknown
	type: unknown
	mode: unknown
	size: unknown
	mtime_ns: unknown
	ctime_ns: unknown
	content_hash: unknown
	symlink_target: unknown
	mime_type: unknown
	storage_kind: unknown
}

type DirentRow = {
	ino: unknown
	type: unknown
	name: unknown
	dir_ino: unknown
}

/** One row of the `TREE_CTE` join: the walked path plus its inode's columns. */
type TreeRow = {
	path: unknown
	ino: unknown
	dir_ino: unknown
	name: unknown
	type: unknown
	mode: unknown
	size: unknown
	mtime_ns: unknown
	ctime_ns: unknown
	content_hash: unknown
	symlink_target: unknown
}

type ContentRow = {
	content_hash: unknown
	storage_kind: unknown
	size: unknown
	inline_bytes: unknown
	inline_text: unknown
	r2_key: unknown
	mime_type: unknown
	text_encoding: unknown
}

const ROOT_INO: Ino = '1'
const DIR_PAGE_SIZE = 200
const SCAN_PAGE_SIZE = 200
// Journal paths examined per prune run. The sweep runs in ONE Durable Object
// event, where `db.transaction` is a no-op wrapper (apps/frieren/worker/db.do.ts)
// so the whole write set flushes at once — a window keeps that event bounded no
// matter how large the journal is, and the caller re-arms while work remains.
// It bounds the READ, which capping the discarded rows does not: the steady state
// is a journal with nothing to discard, and finding that out must not cost a scan.
const JOURNAL_PRUNE_WINDOW = 1000
// Deleted paths collected per run. Smaller than the coalescing window because the
// delete names each path individually.
const TOMBSTONE_SWEEP_LIMIT = 500
// How long a deleted path stays in the journal. A device that has been away longer
// re-bootstraps (keeping its local data) instead of resuming, so this is the window
// in which an offline device stays on the cheap path — not a correctness bound.
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
// R2 takes up to 1000 keys per `delete`.
const BLOB_DELETE_BATCH = 1000
const INLINE_TEXT_LIMIT_BYTES = 256 * 1024
const STORAGE_NONE = 0
const STORAGE_INLINE = 1
const STORAGE_R2 = 2

// The whole tree as (path, ino) pairs in parent-before-child order, walked DOWN
// from the root's dirents. `path` is RELATIVE — no leading '/' — because that is
// what `fullScan`'s page cursor has always been; a canonical path is one `'/' ||`
// away, and only the sync snapshot needs it. Shared by `fullScan` (the VFS tree
// walk) and `pathSnapshot.puts` (the sync snapshot), which differ only in what they
// select from it.
const TREE_CTE = `WITH RECURSIVE tree(path, ino, dir_ino, name) AS (
		SELECT name, ino, dir_ino, name
		FROM fs_dirents
		WHERE dir_ino = ?
		UNION ALL
		SELECT tree.path || '/' || child.name, child.ino, child.dir_ino, child.name
		FROM tree
		JOIN fs_inodes inode ON inode.ino = tree.ino
		JOIN fs_dirents child ON child.dir_ino = tree.ino
		WHERE inode.type = ?
	)`

function nowNs(): bigint {
	return BigInt(Date.now()) * 1_000_000n
}

function randomId(): string {
	return crypto.randomUUID()
}

function toBigInt(value: unknown): bigint {
	if (typeof value === 'bigint') return value
	if (typeof value === 'number') return BigInt(Math.trunc(value))
	return BigInt(String(value))
}

function toNumber(value: unknown): number {
	if (typeof value === 'number') return value
	if (typeof value === 'bigint') return Number(value)
	return Number(String(value))
}

function toStringOrNull(value: unknown): string | null {
	return value == null ? null : String(value)
}

function toUint8Array(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return value
	if (value instanceof ArrayBuffer) return new Uint8Array(value)
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
	}
	if (typeof value === 'string') return new TextEncoder().encode(value)
	throw new Error(`Unsupported blob value: ${typeof value}`)
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(value.byteLength)
	new Uint8Array(buffer).set(value)
	return buffer
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

function buildMissingInodeMeta(partial: Partial<InodeMeta>): InodeMeta | null {
	if (partial.type === undefined) return null
	const stamp = nowNs()
	return {
		type: partial.type,
		size: partial.size ?? 0n,
		mode: partial.mode ?? defaultModeForType(partial.type),
		mtimeNs: partial.mtimeNs ?? stamp,
		ctimeNs: partial.ctimeNs ?? stamp,
		contentHash: partial.contentHash,
		symlinkTarget: partial.symlinkTarget
	}
}

function metaFromRow(row: InodeRow): InodeMeta {
	return {
		type: toNumber(row.type) as FileType,
		size: toBigInt(row.size),
		mode: toNumber(row.mode),
		mtimeNs: toBigInt(row.mtime_ns),
		ctimeNs: toBigInt(row.ctime_ns),
		contentHash: toStringOrNull(row.content_hash) ?? undefined,
		symlinkTarget: toStringOrNull(row.symlink_target) ?? undefined
	}
}

/** Every xattr of a page's inodes, in one query, grouped by ino. */
async function readXattrsByIno(
	tx: DbAdapter,
	inos: string[]
): Promise<Map<string, Record<string, Uint8Array>>> {
	const byIno = new Map<string, Record<string, Uint8Array>>()
	if (inos.length === 0) return byIno
	const rows = await tx.query<{ ino: unknown; name: unknown; value: unknown }>(
		`SELECT ino, name, value FROM fs_xattrs WHERE ino IN (${inos.map(() => '?').join(', ')})`,
		inos
	)
	for (const row of rows) {
		const ino = String(row.ino)
		const xattrs = byIno.get(ino) ?? {}
		xattrs[String(row.name)] = toUint8Array(row.value)
		byIno.set(ino, xattrs)
	}
	return byIno
}

async function listAllXattrs(tx: DbAdapter, ino: Ino): Promise<Record<string, Uint8Array>> {
	const rows = await tx.query<{ name: unknown; value: unknown }>(
		'SELECT name, value FROM fs_xattrs WHERE ino = ? ORDER BY name',
		[ino]
	)
	return Object.fromEntries(rows.map((row) => [String(row.name), toUint8Array(row.value)]))
}

async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(data))
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

function inferText(data: Uint8Array, limit: number): { text: string; mimeType: string } | null {
	if (data.length > limit) return null
	if (data.includes(0)) return null

	let text: string
	try {
		text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data)
	} catch {
		return null
	}

	let suspicious = 0
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		const isControl = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d
		if (isControl) suspicious++
	}
	if (suspicious > 0) return null

	return { text, mimeType: 'text/plain; charset=utf-8' }
}

export function storage(
	db: DbAdapter,
	options: StorageOptions = {}
): JournaledStorage & SyncCapableStorage {
	const blobStore = options.blobStore
	const namespace = options.namespace ?? 'default'
	const inlineTextLimit = options.inlineTextLimitBytes ?? INLINE_TEXT_LIMIT_BYTES
	const localActorId = options.localActorId ?? 'local'
	let bootstrapPromise: Promise<void> | null = null

	// Change feed — the substrate for volume.watch and, critically, cache
	// invalidation when the sync layer applies remote pulls straight to Storage
	// (applyJournaled bypasses the volume mutators). Listeners fire AFTER a
	// mutation's transaction commits; near-zero cost when nobody is listening.
	const listeners = new Set<(change: StorageChange) => void>()
	function emit(change: StorageChange): void {
		if (listeners.size === 0) return
		for (const fn of [...listeners]) fn(change)
	}

	async function ensureBootstrapped(): Promise<void> {
		if (bootstrapPromise) return bootstrapPromise
		bootstrapPromise = (async () => {
			const existing = await db.query<{ ino: unknown }>(
				'SELECT ino FROM fs_inodes WHERE ino = ? LIMIT 1',
				[ROOT_INO]
			)
			if (existing.length > 0) return

			const now = nowNs()
			await db.transaction(async (tx) => {
				await tx.run(
					`INSERT OR IGNORE INTO fs_inodes(
						ino, type, mode, size, mtime_ns, ctime_ns, content_hash, symlink_target, mime_type, storage_kind
					) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
					[ROOT_INO, FileType.Directory, 0o755, 0, now, now, STORAGE_NONE]
				)
			})
		})()
		try {
			await bootstrapPromise
		} catch (error) {
			bootstrapPromise = null
			throw error
		}
	}

	async function getInode(tx: DbAdapter, ino: Ino): Promise<InodeRow | null> {
		const [row] = await tx.query<InodeRow>('SELECT * FROM fs_inodes WHERE ino = ? LIMIT 1', [ino])
		return row ?? null
	}

	async function getDirent(tx: DbAdapter, dirIno: Ino, name: string): Promise<DirentRow | null> {
		const [row] = await tx.query<DirentRow>(
			'SELECT dir_ino, name, ino, type FROM fs_dirents WHERE dir_ino = ? AND name = ? LIMIT 1',
			[dirIno, name]
		)
		return row ?? null
	}

	async function ensureDirectory(tx: DbAdapter, dirIno: Ino): Promise<void> {
		const row = await getInode(tx, dirIno)
		if (!row) throw new Error(`ENOENT: ${dirIno}`)
		if (toNumber(row.type) !== FileType.Directory) throw new Error(`ENOTDIR: ${dirIno}`)
	}

	async function ensureDirentTarget(
		tx: DbAdapter,
		dirIno: Ino,
		entry: { ino: Ino; type: FileType }
	): Promise<void> {
		await ensureDirectory(tx, dirIno)
		const row = await getInode(tx, entry.ino)
		if (!row) throw new Error(`ENOENT: ${entry.ino}`)
		if (toNumber(row.type) !== entry.type) {
			throw new Error(`EINVAL: dirent type mismatch for ${entry.ino}`)
		}
	}

	async function hasDirentReference(tx: DbAdapter, ino: Ino): Promise<boolean> {
		const rows = await tx.query<{ present: unknown }>(
			'SELECT 1 AS present FROM fs_dirents WHERE ino = ? LIMIT 1',
			[ino]
		)
		return rows.length > 0
	}

	async function ensureRegularFile(tx: DbAdapter, ino: Ino): Promise<InodeRow> {
		const row = await getInode(tx, ino)
		if (!row) throw new Error(`ENOENT: ${ino}`)
		if (toNumber(row.type) !== FileType.Regular)
			throw new Error(`EINVAL: ${ino} is not a regular file`)
		return row
	}

	async function insertFtsRow(
		tx: DbAdapter,
		contentHash: string,
		text: string | null
	): Promise<void> {
		if (text == null) return
		await tx.run('INSERT OR REPLACE INTO fs_content_fts(content_hash, text) VALUES (?, ?)', [
			contentHash,
			text
		])
	}

	async function deleteFtsRow(tx: DbAdapter, contentHash: string): Promise<void> {
		await tx.run('DELETE FROM fs_content_fts WHERE content_hash = ?', [contentHash])
	}

	async function loadContentRow(tx: DbAdapter, contentHash: string): Promise<ContentRow | null> {
		const [row] = await tx.query<ContentRow>(
			'SELECT * FROM fs_contents WHERE content_hash = ? LIMIT 1',
			[contentHash]
		)
		return row ?? null
	}

	async function maybeDeleteOrphanedContent(
		tx: DbAdapter,
		contentHash: string | null,
		orphanedR2Keys: string[]
	): Promise<void> {
		if (!contentHash) return
		const refs = await tx.query<{ ref_count: unknown }>(
			'SELECT COUNT(*) AS ref_count FROM fs_inodes WHERE content_hash = ?',
			[contentHash]
		)
		if (toNumber(refs[0]?.ref_count ?? 0) > 0) return

		const content = await loadContentRow(tx, contentHash)
		if (!content) return

		await tx.run('DELETE FROM fs_contents WHERE content_hash = ?', [contentHash])
		await deleteFtsRow(tx, contentHash)

		if (toNumber(content.storage_kind) === STORAGE_R2) {
			const key = toStringOrNull(content.r2_key)
			if (key) orphanedR2Keys.push(key)
		}
	}

	function blobKey(contentHash: string): string {
		return `${namespace}/fs/blobs/sha256/${contentHash}`
	}

	/**
	 * Drop orphaned blobs from the external store, batched. Always OUTSIDE the
	 * transaction that dropped their rows: R2 can never join it, and the rows are
	 * what make the bytes reachable — so losing the deletes leaks paid-for garbage
	 * (#333), while losing the rows would be data loss.
	 */
	async function deleteBlobs(keys: string[]): Promise<void> {
		if (!blobStore?.delete) return
		for (let i = 0; i < keys.length; i += BLOB_DELETE_BATCH)
			await blobStore.delete(keys.slice(i, i + BLOB_DELETE_BATCH))
	}

	// Storing content is TWO halves, and which transaction each belongs in is the whole
	// point of separating them.
	//
	// `stageContent` does the EXTERNAL work — an R2 round trip for anything not inlined.
	// It must never run inside a claim: an await on the network between "this name is
	// free" and "this name is mine" is a TOCTOU wide enough to lose, and on the Durable
	// Object `DbAdapter.transaction` is `await fn(adapter)` with no isolation and no
	// rollback (apps/frieren/worker/db.do.ts), so the loser cannot undo the rows it has
	// already inserted — it leaks an unreachable inode and reports a raw UNIQUE-constraint
	// error instead of EEXIST, which `writeFile`'s plain-create retry then never matches.
	//
	// Staging bytes commits no REFERENCE to them, which is the direction that must never
	// be reversed: a row pointing at missing bytes is data loss (#321/#323/#324), while
	// bytes with no row are only paid-for garbage.
	//
	// KNOWN COST (#333): that garbage is currently PERMANENT. `gcUnreferenced` sweeps
	// `fs_contents` ROWS, so an R2 object with no row is invisible to it — and because a
	// lost claim is ordinary contention rather than a fault, this leaks on a schedule
	// rather than on a failure. Not fixed here because the fix is a destructive R2 prefix
	// sweep, guarded by an in-process staging registry rather than a time-based quarantine
	// (the issue records why delete-on-failure and quarantines are both unsafe), and that
	// wants its own review. R2 is external and can never join this transaction, so the
	// instant itself is unavoidable — only its discoverability can be fixed.
	type StagedContent =
		| { storageKind: number; mimeType: string; text: string | null; key: null }
		| { storageKind: number; mimeType: string; text: null; key: string }

	async function stageContent(contentHash: string, data: Uint8Array): Promise<StagedContent> {
		const textInfo = inferText(data, inlineTextLimit)
		if (!blobStore || textInfo) {
			return {
				storageKind: STORAGE_INLINE,
				mimeType: textInfo?.mimeType ?? 'application/octet-stream',
				text: textInfo?.text ?? null,
				key: null
			}
		}
		const key = blobKey(contentHash)
		await blobStore.put(key, data, {
			httpMetadata: { contentType: 'application/octet-stream' },
			customMetadata: { namespace, contentHash }
		})
		return { storageKind: STORAGE_R2, mimeType: 'application/octet-stream', text: null, key }
	}

	// …and the ROW half: local statements only, so it is safe inside a claim.
	async function recordStagedContent(
		tx: DbAdapter,
		contentHash: string,
		data: Uint8Array,
		staged: StagedContent
	): Promise<void> {
		// Checked in the SAME transaction that inserts, so two writers of identical content
		// cannot both decide the row is missing and collide on the primary key.
		if (await loadContentRow(tx, contentHash)) return
		if (staged.key === null) {
			await tx.run(
				`INSERT INTO fs_contents(
					content_hash, storage_kind, size, inline_bytes, inline_text, r2_key, mime_type, text_encoding, created_at_ns
				) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
				[
					contentHash,
					STORAGE_INLINE,
					data.length,
					data,
					staged.text,
					staged.mimeType,
					staged.text !== null ? 'utf-8' : null,
					nowNs()
				]
			)
			await insertFtsRow(tx, contentHash, staged.text)
			return
		}
		await tx.run(
			`INSERT INTO fs_contents(
				content_hash, storage_kind, size, inline_bytes, inline_text, r2_key, mime_type, text_encoding, created_at_ns
			) VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, ?)`,
			[contentHash, STORAGE_R2, data.length, staged.key, staged.mimeType, nowNs()]
		)
	}

	// The composed form, for callers that are NOT claiming a name (`putBlob` edits an
	// inode it already resolved, so it has nothing to lose a race for). Same SQL as
	// above, one implementation — only the ordering differs, and that is the caller's
	// decision to make.
	async function storeContentIfMissing(
		tx: DbAdapter,
		contentHash: string,
		data: Uint8Array
	): Promise<{ storageKind: number; mimeType: string | null }> {
		const existing = await loadContentRow(tx, contentHash)
		if (existing) {
			return {
				storageKind: toNumber(existing.storage_kind),
				mimeType: toStringOrNull(existing.mime_type)
			}
		}
		const staged = await stageContent(contentHash, data)
		await recordStagedContent(tx, contentHash, data, staged)
		return { storageKind: staged.storageKind, mimeType: staged.mimeType }
	}

	async function readFullContent(tx: DbAdapter, ino: Ino): Promise<Uint8Array> {
		const inode = await ensureRegularFile(tx, ino)
		const hash = toStringOrNull(inode.content_hash)
		if (!hash) return new Uint8Array()

		const content = await loadContentRow(tx, hash)
		if (!content) throw new Error(`Missing content for inode: ${ino}`)

		if (toNumber(content.storage_kind) === STORAGE_INLINE) {
			return toUint8Array(content.inline_bytes)
		}

		if (!blobStore) throw new Error(`Blob store not configured for inode: ${ino}`)
		const key = toStringOrNull(content.r2_key)
		if (!key) throw new Error(`Missing R2 key for inode: ${ino}`)
		const object = await blobStore.get(key)
		if (!object) throw new Error(`Blob not found for inode: ${ino}`)
		return new Uint8Array(await object.arrayBuffer())
	}

	/**
	 * Free an inode only when it has no remaining directory entry references.
	 * Sync rename replay can temporarily create a second name for the same inode
	 * before removing the old one.
	 */
	async function deleteInodeInTx(tx: DbAdapter, ino: Ino, orphanedR2Keys: string[]): Promise<void> {
		const inode = await getInode(tx, ino)
		if (!inode) return
		if (await hasDirentReference(tx, ino)) return
		const oldHash = toStringOrNull(inode.content_hash)
		await tx.run('DELETE FROM fs_xattrs WHERE ino = ?', [ino])
		await tx.run('DELETE FROM fs_inodes WHERE ino = ?', [ino])
		await maybeDeleteOrphanedContent(tx, oldHash, orphanedR2Keys)
	}

	// ── Path-sync journaling (write-intercept, path-stamped; epic slice 3) ────────
	// Every mutation through the public primitives appends a path-stamped journal
	// row — via the shared pure builders in @justfiles/sync/path — inside its OWN
	// transaction, with a version from fs_path_version and ORIGIN =
	// options.origin ?? localActorId. Mirrors the memory reference implementation.

	/** Resolve ino -> canonical path via a recursive walk up the dirent chain; null if unlinked. */
	async function pathOf(tx: DbAdapter, ino: Ino): Promise<string | null> {
		if (ino === ROOT_INO) return '/'
		const rows = await tx.query<{ name: unknown; depth: unknown }>(
			`WITH RECURSIVE up(ino, name, dir_ino, depth) AS (
				SELECT ino, name, dir_ino, 0 FROM fs_dirents WHERE ino = ?
				UNION ALL
				SELECT d.ino, d.name, d.dir_ino, up.depth + 1
				FROM fs_dirents d JOIN up ON d.ino = up.dir_ino
			)
			SELECT name, depth FROM up ORDER BY depth DESC`,
			[ino]
		)
		if (rows.length === 0) return null
		return `/${rows.map((r) => String(r.name)).join('/')}`
	}

	async function readPathVersion(
		tx: DbAdapter,
		path: string
	): Promise<{ version: number; tombstone: number }> {
		const [row] = await tx.query<{ version: unknown; tombstone_version: unknown }>(
			'SELECT version, tombstone_version FROM fs_path_version WHERE path = ? LIMIT 1',
			[path]
		)
		return {
			version: toNumber(row?.version ?? 0),
			tombstone: toNumber(row?.tombstone_version ?? 0)
		}
	}

	async function setPathVersion(
		tx: DbAdapter,
		path: string,
		version: number,
		tombstone: number
	): Promise<void> {
		await tx.run(
			`INSERT INTO fs_path_version(path, version, tombstone_version) VALUES (?, ?, ?)
			 ON CONFLICT(path) DO UPDATE SET version = excluded.version, tombstone_version = excluded.tombstone_version`,
			[path, version, tombstone]
		)
	}

	async function appendJournalRow(
		tx: DbAdapter,
		change: PathChange,
		localSource?: string
	): Promise<void> {
		// `path` duplicates `change_json.$.path` deliberately: it is the ONLY column the
		// prune groups by, and paying one string write here buys an index range scan
		// instead of a `json_extract` over every row of the table (0007_journal_path).
		// `at_ns` is what the retention window measures (0009_journal_floor).
		await tx.run(
			'INSERT INTO fs_path_journal(local_source, change_json, path, at_ns) VALUES (?, ?, ?, ?)',
			[localSource ?? null, JSON.stringify(change), change.path, nowNs()]
		)
		// AT MOST ONE ROW PER PATH, always — a new row takes out the rows it supersedes,
		// here, rather than leaving them for the daily prune (#446).
		//
		// This is correctness, not tidiness. THIS backend drops a superseded contentHash
		// inline (`maybeDeleteOrphanedContent`, in the same transaction as the overwrite),
		// so a surviving older row names bytes the volume no longer has. `pathDeltas`
		// coalesces each page by path and normally hides such a row behind its successor
		// — but only within one page, and a page cut between the two serves the stale one
		// alone. The client fetches its hash, gets nothing, and the pull cursor never
		// advances past that page again.
		//
		// After the INSERT, never before it: `db.transaction` is a no-op wrapper on the
		// Durable Object (apps/frieren/worker/db.do.ts), so a delete-then-insert would
		// expose an instant with no row for this path at all. `seq` is AUTOINCREMENT, so
		// the row just written is the new maximum and no reader's cursor can be above it.
		await tx.run(
			`DELETE FROM fs_path_journal
			 WHERE path = ? AND seq < (SELECT MAX(seq) FROM fs_path_journal WHERE path = ?)`,
			[change.path, change.path]
		)
	}

	/**
	 * Collect the journal rows of paths that have been DELETED for longer than the
	 * retention window, and raise the floor a reader may resume from. Returns whether
	 * the sweep drained.
	 *
	 * This is the one prune that a lagging cursor cannot survive, which is what the
	 * floor is for: coalescing only ever removes a row that a HIGHER seq on the same
	 * path supersedes, so any reader still converges — but a path's LAST row has no
	 * successor, and a reader below it would simply never learn the path is gone.
	 * `journal_pruned_below` records that, and `GET /path/changes` answers `410` under
	 * it so the device re-bootstraps (keeping its local data) instead of diverging.
	 *
	 * ALL of a path's rows go, or none. A path with `put@10` and `delete@50` that lost
	 * only its delete would coalesce back to the put — the file returns from the dead
	 * for every device that bootstraps afterwards. The sweep selects by PATH, so it
	 * takes every row a path owns; and the caller runs it only on the run that
	 * FINISHES a coalescing pass, which bounds what that costs — a path this sweep can
	 * reach was coalesced during the pass and has gained nothing since, because a row
	 * written since would be newer than the retention horizon.
	 *
	 * `fs_path_version` decides what "deleted" means (the same test the tombstone
	 * snapshot uses), so no row here is parsed as JSON.
	 */
	async function sweepTombstones(tx: DbAdapter): Promise<boolean> {
		// `CAST(? AS INTEGER)` below, and not a bare `?`: the Durable Object adapter
		// binds a bigint as TEXT (apps/frieren/worker/db.do.ts `normalizeArgs`), and
		// `MAX(at_ns)` is a function result, which carries no column affinity — so
		// SQLite would compare by STORAGE CLASS, where every integer sorts below every
		// string. The window would silently be zero, and every tombstone would go on the
		// first run.
		const horizon = nowNs() - BigInt(TOMBSTONE_RETENTION_MS) * 1_000_000n
		const aged = await tx.query<{ path: unknown; newest: unknown }>(
			`SELECT journal.path AS path, MAX(journal.seq) AS newest
			 FROM fs_path_journal AS journal
			 JOIN fs_path_version AS version ON version.path = journal.path
			 WHERE version.tombstone_version > 0 AND version.tombstone_version >= version.version
			 GROUP BY journal.path
			 HAVING MAX(journal.at_ns) < CAST(? AS INTEGER)
			 ORDER BY newest
			 LIMIT ?`,
			[horizon, TOMBSTONE_SWEEP_LIMIT]
		)
		if (aged.length === 0) return true
		const paths = aged.map((row) => String(row.path))
		await tx.run(
			`DELETE FROM fs_path_journal WHERE path IN (${paths.map(() => '?').join(', ')})`,
			paths
		)
		// The floor is the highest seq collected: a reader AT it has already seen every
		// row up to and including it, so only a reader strictly below has lost history.
		const floor = aged.reduce((max, row) => Math.max(max, toNumber(row.newest)), 0)
		await tx.run(
			'UPDATE fs_generation SET journal_pruned_below = MAX(journal_pruned_below, ?) WHERE id = 1',
			[floor]
		)
		return aged.length < TOMBSTONE_SWEEP_LIMIT
	}

	/**
	 * Announce one tree change to the attached observer, inside the mutation's own
	 * transaction and after the write (#454).
	 */
	async function record(
		tx: DbAdapter,
		effect: TreeEffect,
		options?: MutationOptions
	): Promise<void> {
		const { tree, sync } = makePathPorts(tx)
		await pathSyncObserver(sync, localActorId).record(tree, effect, options)
		await nodeSyncObserver(makeNodeStore(tx)).record(tree, effect, options)
	}

	// ── Path-sync apply (remote pull; epic slice 4) ──────────────────────────────
	// Resolve a canonical path to an ino by walking dirents; null if absent.
	async function resolveIno(tx: DbAdapter, path: string): Promise<Ino | null> {
		if (path === '/') return ROOT_INO
		let cur: Ino = ROOT_INO
		for (const seg of path.slice(1).split('/')) {
			const dirent = await getDirent(tx, cur, seg)
			if (!dirent) return null
			cur = String(dirent.ino)
		}
		return cur
	}

	// Ensure every segment of a directory path exists, creating missing dirs; return
	// the deepest ino. This is the tree-repair / ancestor-resurrection path: a
	// winning descendant put recreates a deleted ancestor directory.
	async function ensureDirPath(tx: DbAdapter, path: string): Promise<Ino> {
		if (path === '/') return ROOT_INO
		let cur: Ino = ROOT_INO
		for (const seg of path.slice(1).split('/')) {
			const dirent = await getDirent(tx, cur, seg)
			if (dirent) {
				cur = String(dirent.ino)
				continue
			}
			const ino = randomId()
			const stamp = nowNs()
			await tx.run(
				`INSERT INTO fs_inodes(ino, type, mode, size, mtime_ns, ctime_ns, content_hash, symlink_target, mime_type, storage_kind)
				 VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
				[ino, FileType.Directory, 0o755, 0, stamp, stamp, STORAGE_NONE]
			)
			await tx.run('INSERT INTO fs_dirents(dir_ino, name, ino, type) VALUES (?, ?, ?, ?)', [
				cur,
				seg,
				ino,
				FileType.Directory
			])
			cur = ino
		}
		return cur
	}

	// All paths in the subtree rooted at `ino`, as { ino, rel } (root rel = ''), via
	// a recursive walk DOWN the dirent tree. Used to journal a rename as an ordered
	// subtree delete + put.
	async function enumerateSubtree(tx: DbAdapter, ino: Ino): Promise<{ ino: Ino; rel: string }[]> {
		const rows = await tx.query<{ ino: unknown; rel: unknown }>(
			`WITH RECURSIVE subtree(ino, rel) AS (
				SELECT ?, ''
				UNION ALL
				SELECT d.ino, subtree.rel || '/' || d.name
				FROM fs_dirents d JOIN subtree ON d.dir_ino = subtree.ino
			)
			SELECT ino, rel FROM subtree`,
			[ino]
		)
		return rows.map((r) => ({ ino: String(r.ino), rel: toStringOrNull(r.rel) ?? '' }))
	}

	// Upsert an inode from a remote put's SyncMeta: tree metadata + the contentHash
	// REFERENCE (bytes are materialised out-of-band by applyPathChanges), and REPLACE
	// the user-xattr set with the wire snapshot (local-only trusted.sync.* untouched).
	// The shared apply driver converts the wire payload before it reaches this tree seam.
	async function upsertInode(
		tx: DbAdapter,
		ino: Ino,
		meta: InodeMeta,
		contentHash: string | undefined,
		snapshot: Record<string, Uint8Array>,
		content?: Uint8Array,
		prepared?: ReadonlyMap<string, { data: Uint8Array; staged: StagedContent }>
	): Promise<void> {
		if (contentHash && content) {
			if ((await sha256Hex(content)) !== contentHash)
				throw new Error(`hash mismatch: ${contentHash}`)
			const pending = prepared?.get(contentHash)
			if (pending) await recordStagedContent(tx, contentHash, pending.data, pending.staged)
			else await storeContentIfMissing(tx, contentHash, content)
		}
		const storedContent = contentHash ? await loadContentRow(tx, contentHash) : null
		if (contentHash && !storedContent) throw new Error(`missing blob ${contentHash}`)
		await tx.run(
			`INSERT INTO fs_inodes(ino, type, mode, size, mtime_ns, ctime_ns, content_hash, symlink_target, mime_type, storage_kind)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(ino) DO UPDATE SET
			   type = excluded.type, mode = excluded.mode, size = excluded.size,
			   mtime_ns = excluded.mtime_ns, ctime_ns = excluded.ctime_ns,
			   content_hash = excluded.content_hash, symlink_target = excluded.symlink_target,
			   mime_type = excluded.mime_type, storage_kind = excluded.storage_kind`,
			[
				ino,
				meta.type,
				meta.mode,
				Number(meta.size),
				meta.mtimeNs,
				meta.ctimeNs,
				contentHash ?? null,
				meta.symlinkTarget ?? null,
				toStringOrNull(storedContent?.mime_type),
				storedContent ? toNumber(storedContent.storage_kind) : STORAGE_NONE
			]
		)
		// Replace the whole USER-xattr set with the snapshot; keep trusted.sync.*.
		await tx.run("DELETE FROM fs_xattrs WHERE ino = ? AND name NOT LIKE 'trusted.sync.%'", [ino])
		for (const [name, value] of Object.entries(snapshot)) {
			await tx.run(
				`INSERT INTO fs_xattrs(ino, name, value) VALUES (?, ?, ?)
				 ON CONFLICT(ino, name) DO UPDATE SET value = excluded.value`,
				[ino, name, value]
			)
		}
	}

	async function setDirent(
		tx: DbAdapter,
		dirIno: Ino,
		name: string,
		ino: Ino,
		type: FileType
	): Promise<void> {
		const existing = await getDirent(tx, dirIno, name)
		if (existing)
			await tx.run('UPDATE fs_dirents SET ino = ?, type = ? WHERE dir_ino = ? AND name = ?', [
				ino,
				type,
				dirIno,
				name
			])
		else
			await tx.run('INSERT INTO fs_dirents(dir_ino, name, ino, type) VALUES (?, ?, ?, ?)', [
				dirIno,
				name,
				ino,
				type
			])
	}

	// The storage-independent seam the shared apply driver + the mutation observer
	// sync path operation, bound to one transaction (or `db` for read-only
	// localChange). `emit` is buffered so a transactional apply can flush AFTER commit.
	function makePathPorts(
		tx: DbAdapter,
		preparedContent?: ReadonlyMap<string, { data: Uint8Array; staged: StagedContent }>
	): {
		tree: TreePort
		sync: PathSyncStore
		emits: StorageChange[]
	} {
		const emits: StorageChange[] = []
		const tree: TreePort = {
			mintIno: randomId,
			resolveIno: (path) => resolveIno(tx, path),
			pathOf: (ino) => pathOf(tx, ino),
			enumerateSubtree: (ino) => enumerateSubtree(tx, ino),
			ensureDirPath: (path) => ensureDirPath(tx, path),
			async getDirent(dirIno, name) {
				const d = await getDirent(tx, dirIno, name)
				return d ? { ino: String(d.ino), type: toNumber(d.type) as FileType } : null
			},
			async readMetaXattrs(ino) {
				const row = await getInode(tx, ino)
				if (!row) return null
				return { meta: metaFromRow(row), xattrs: await listAllXattrs(tx, ino) }
			},
			upsertInode: (ino, meta, contentHash, xattrs, content) =>
				upsertInode(tx, ino, meta, contentHash, xattrs, content, preparedContent),
			setDirent: (dirIno, name, ino, type) => setDirent(tx, dirIno, name, ino, type),
			async deleteDirent(dirIno, name) {
				await tx.run('DELETE FROM fs_dirents WHERE dir_ino = ? AND name = ?', [dirIno, name])
			},
			async deleteInodeIfUnreferenced(ino) {
				// Delete tree metadata + xattrs, but NEVER the blob content: a later put in
				// the same batch may re-reference the bytes (rename applies deletes first).
				// Blob GC is out-of-band.
				if (await hasDirentReference(tx, ino)) return
				await tx.run('DELETE FROM fs_xattrs WHERE ino = ?', [ino])
				await tx.run('DELETE FROM fs_inodes WHERE ino = ?', [ino])
			},
			async dirHasLiveChildren(ino) {
				const rows = await tx.query<{ present: unknown }>(
					'SELECT 1 AS present FROM fs_dirents WHERE dir_ino = ? LIMIT 1',
					[ino]
				)
				return rows.length > 0
			},
			emit(change) {
				emits.push(change)
			}
		}
		const sync: PathSyncStore = {
			readPathVersion: (path) => readPathVersion(tx, path),
			setPathVersion: (path, version, tombstone) => setPathVersion(tx, path, version, tombstone),
			appendJournalRow: (change, localSource) => appendJournalRow(tx, change, localSource)
		}
		return { tree, sync, emits }
	}

	function nodeStateFromRow(row: {
		sync_id: unknown
		local_ino: unknown
		parent_sync_id: unknown
		name: unknown
		type: unknown
		revision: unknown
		deleted: unknown
		meta_json: unknown
		content_hash: unknown
	}): NodeState {
		return {
			id: String(row.sync_id),
			localIno: toStringOrNull(row.local_ino),
			parentId: toStringOrNull(row.parent_sync_id),
			name: String(row.name),
			type: toNumber(row.type) as FileType,
			revision: toNumber(row.revision),
			deleted: toNumber(row.deleted) === 1,
			meta: JSON.parse(String(row.meta_json)) as NodeState['meta'],
			contentHash: toStringOrNull(row.content_hash) ?? undefined
		}
	}

	function makeNodeStore(tx: DbAdapter): NodeStore {
		return {
			async get(id) {
				const [row] = await tx.query<{
					sync_id: unknown
					local_ino: unknown
					parent_sync_id: unknown
					name: unknown
					type: unknown
					revision: unknown
					deleted: unknown
					meta_json: unknown
					content_hash: unknown
				}>('SELECT * FROM fs_sync_nodes WHERE sync_id = ? LIMIT 1', [id])
				return row ? nodeStateFromRow(row) : null
			},
			async idFor(ino) {
				const [row] = await tx.query<{ sync_id: unknown }>(
					'SELECT sync_id FROM fs_sync_nodes WHERE local_ino = ? LIMIT 1',
					[ino]
				)
				return row ? String(row.sync_id) : null
			},
			async live() {
				const rows = await tx.query<{
					sync_id: unknown
					local_ino: unknown
					parent_sync_id: unknown
					name: unknown
					type: unknown
					revision: unknown
					deleted: unknown
					meta_json: unknown
					content_hash: unknown
				}>('SELECT * FROM fs_sync_nodes WHERE deleted = 0')
				return rows.map(nodeStateFromRow)
			},
			async save(state) {
				await tx.run(
					`INSERT INTO fs_sync_nodes(
						sync_id, local_ino, parent_sync_id, name, type, revision, deleted, meta_json, content_hash
					 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(sync_id) DO UPDATE SET
						local_ino = excluded.local_ino,
						parent_sync_id = excluded.parent_sync_id,
						name = excluded.name,
						type = excluded.type,
						revision = excluded.revision,
						deleted = excluded.deleted,
						meta_json = excluded.meta_json,
						content_hash = excluded.content_hash`,
					[
						state.id,
						state.localIno,
						state.parentId,
						state.name,
						state.type,
						state.revision,
						state.deleted ? 1 : 0,
						JSON.stringify(state.meta),
						state.contentHash ?? null
					]
				)
			},
			async append(operation, localSource) {
				const affected = [
					...new Set(
						operation.mutations.flatMap((mutation) =>
							mutation.kind === 'update' || mutation.kind === 'delete' ? [mutation.nodeId] : []
						)
					)
				]
				if (affected.length > 0) {
					const references = await tx.query<{ seq: unknown }>(
						`SELECT DISTINCT seq FROM fs_node_journal_mutations
						 WHERE node_id IN (${affected.map(() => '?').join(', ')})`,
						affected
					)
					const sequences = references.map((row) => toNumber(row.seq))
					if (sequences.length > 0) {
						const stored = await tx.query<{
							seq: unknown
							local_source: unknown
							operation_json: unknown
						}>(
							`SELECT seq, local_source, operation_json FROM fs_node_journal
							 WHERE seq IN (${sequences.map(() => '?').join(', ')}) ORDER BY seq`,
							sequences
						)
						const rows = stored.map(
							(row): NodeJournalRow => ({
								seq: toNumber(row.seq),
								operation: NodeOperation.parse(JSON.parse(String(row.operation_json))),
								localSource: toStringOrNull(row.local_source) ?? undefined
							})
						)
						const deleted = operation.mutations.flatMap((mutation) =>
							mutation.kind === 'delete' ? [mutation.nodeId] : []
						)
						const directoryTombstones = new Set<string>()
						if (deleted.length > 0) {
							const states = await tx.query<{ sync_id: unknown }>(
								`SELECT sync_id FROM fs_sync_nodes
								 WHERE type = ? AND sync_id IN (${deleted.map(() => '?').join(', ')})`,
								[FileType.Directory, ...deleted]
							)
							for (const state of states) directoryTombstones.add(String(state.sync_id))
						}
						const compacted = new Map(
							compactNodeJournal(rows, operation, directoryTombstones).map((row) => [row.seq, row])
						)
						for (const row of rows) {
							const next = compacted.get(row.seq)
							if (next === row) continue
							await tx.run('DELETE FROM fs_node_journal_mutations WHERE seq = ?', [row.seq])
							if (!next) {
								await tx.run('DELETE FROM fs_node_journal WHERE seq = ?', [row.seq])
								continue
							}
							await tx.run('UPDATE fs_node_journal SET operation_json = ? WHERE seq = ?', [
								JSON.stringify(next.operation),
								row.seq
							])
							for (const mutation of next.operation.mutations)
								await tx.run(
									`INSERT OR IGNORE INTO fs_node_journal_mutations(seq, node_id, kind)
									 VALUES (?, ?, ?)`,
									[row.seq, mutation.nodeId, mutation.kind]
								)
						}
					}
				}
				await tx.run('UPDATE fs_node_clock SET head = head + 1 WHERE id = 1')
				const [clock] = await tx.query<{ head: unknown }>(
					'SELECT head FROM fs_node_clock WHERE id = 1 LIMIT 1'
				)
				await tx.run(
					'INSERT INTO fs_node_journal(seq, local_source, operation_json) VALUES (?, ?, ?)',
					[toNumber(clock?.head ?? 0), localSource ?? null, JSON.stringify(operation)]
				)
				const seq = toNumber(clock?.head ?? 0)
				for (const mutation of operation.mutations)
					await tx.run(
						`INSERT OR IGNORE INTO fs_node_journal_mutations(seq, node_id, kind)
						 VALUES (?, ?, ?)`,
						[seq, mutation.nodeId, mutation.kind]
					)
			},
			async read(after, limit) {
				const rows = await tx.query<{
					seq: unknown
					local_source: unknown
					operation_json: unknown
				}>(
					`SELECT seq, local_source, operation_json
					 FROM fs_node_journal WHERE seq > ? ORDER BY seq LIMIT ?`,
					[after, limit]
				)
				return rows.map(
					(row): NodeJournalRow => ({
						seq: toNumber(row.seq),
						operation: NodeOperation.parse(JSON.parse(String(row.operation_json))),
						localSource: toStringOrNull(row.local_source) ?? undefined
					})
				)
			},
			async head() {
				const [row] = await tx.query<{ head: unknown }>(
					'SELECT head FROM fs_node_clock WHERE id = 1 LIMIT 1'
				)
				return toNumber(row?.head ?? 0)
			}
		}
	}

	async function updateInodeContent(
		ino: Ino,
		data: Uint8Array,
		options?: MutationOptions
	): Promise<void> {
		await ensureBootstrapped()
		const orphanedR2Keys: string[] = []

		await db.transaction(async (tx) => {
			const inode = await ensureRegularFile(tx, ino)
			const contentHash = await sha256Hex(data)
			const { storageKind, mimeType } = await storeContentIfMissing(tx, contentHash, data)
			const stamp = nowNs()

			await tx.run(
				`UPDATE fs_inodes
				 SET size = ?, content_hash = ?, mime_type = ?, storage_kind = ?, mtime_ns = ?, ctime_ns = ?
				 WHERE ino = ?`,
				[data.length, contentHash, mimeType, storageKind, stamp, stamp, ino]
			)

			await maybeDeleteOrphanedContent(tx, toStringOrNull(inode.content_hash), orphanedR2Keys)

			await record(tx, { kind: 'content', ino, contentHash }, options)
		})

		emit({ ino, kind: 'content', source: options?.origin })
		await deleteBlobs(orphanedR2Keys)
	}

	// ── StorageCapabilities ──────────────────────────────────────────────────────

	const implemented = {
		async getXattr(ino: Ino, name: string): Promise<Uint8Array | null> {
			await ensureBootstrapped()
			const rows = await db.query<{ value: unknown }>(
				'SELECT value FROM fs_xattrs WHERE ino = ? AND name = ? LIMIT 1',
				[ino, name]
			)
			if (rows.length === 0) return null
			return toUint8Array(rows[0].value)
		},

		async setXattr(ino: Ino, name: string, value: Uint8Array): Promise<void> {
			await ensureBootstrapped()
			await db.transaction(async (tx) => {
				const inode = await getInode(tx, ino)
				if (!inode) throw new Error(`ENOENT: ${ino}`)
				await tx.run(
					`INSERT INTO fs_xattrs(ino, name, value) VALUES (?, ?, ?)
					 ON CONFLICT(ino, name) DO UPDATE SET value = excluded.value`,
					[ino, name, value]
				)
			})
		},

		async listXattrs(ino: Ino): Promise<string[]> {
			await ensureBootstrapped()
			const rows = await db.query<{ name: unknown }>(
				'SELECT name FROM fs_xattrs WHERE ino = ? ORDER BY name',
				[ino]
			)
			return rows.map((row) => String(row.name))
		},

		async removeXattr(ino: Ino, name: string): Promise<void> {
			await ensureBootstrapped()
			await db.transaction(async (tx) => {
				const inode = await getInode(tx, ino)
				if (!inode) throw new Error(`ENOENT: ${ino}`)
				await tx.run('DELETE FROM fs_xattrs WHERE ino = ? AND name = ?', [ino, name])
			})
		},

		// `content` is staged HERE, inside the claim's own transaction (#323), not by the
		// VFS beforehand. Staging it first left the blob committed in `fs_contents` with
		// zero inode references, and `gcUnreferenced()` reclaiming it there was the sweep
		// doing its job — the claim would then publish a `content_hash` pointing at nothing.
		async atomicCreate(
			dirIno: Ino,
			name: string,
			meta: InodeMeta,
			content?: Uint8Array,
			options?: MutationOptions
		): Promise<Ino> {
			await ensureBootstrapped()
			const ino = randomId()
			const stamp = nowNs()
			// The new entry's path, resolved inside the txn and reported on the emit.
			let path: string | undefined
			// Hashed AND staged before the transaction opens — both are external work that
			// commits no reference, and an R2 round trip between the name check and the insert
			// is a window a competing claim wins (see `stageContent`). What is left inside the
			// claim is local statements only.
			const hash = content === undefined ? undefined : await sha256Hex(content)
			const staged =
				content !== undefined && hash !== undefined ? await stageContent(hash, content) : undefined

			await db.transaction(async (tx) => {
				await ensureDirectory(tx, dirIno)
				const existing = await getDirent(tx, dirIno, name)
				if (existing) throw new Error(`EEXIST: ${name}`)

				// Same transaction as the dirent below, so the bytes and the name that
				// references them become visible together or not at all.
				let size = Number(meta.size)
				let contentHash = meta.contentHash ?? null
				let storageKind = STORAGE_NONE
				if (content !== undefined && hash !== undefined && staged !== undefined) {
					await recordStagedContent(tx, hash, content, staged)
					size = content.length
					contentHash = hash
					storageKind = staged.storageKind
				}

				// Trust `meta` verbatim otherwise (mem.ts/idb.ts already do) — a sync-applied
				// create passes a real size/contentHash for content materialised out of band,
				// and a caller with nothing yet passes size:0n/no contentHash.
				await tx.run(
					`INSERT INTO fs_inodes(
						ino, type, mode, size, mtime_ns, ctime_ns, content_hash, symlink_target, mime_type, storage_kind
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
					[
						ino,
						meta.type,
						meta.mode,
						size,
						meta.mtimeNs ?? stamp,
						meta.ctimeNs ?? stamp,
						contentHash,
						meta.symlinkTarget ?? null,
						storageKind
					]
				)
				await tx.run('INSERT INTO fs_dirents(dir_ino, name, ino, type) VALUES (?, ?, ?, ?)', [
					dirIno,
					name,
					ino,
					meta.type
				])
				const dirPath = await pathOf(tx, dirIno)
				if (dirPath !== null) path = joinPath(dirPath, name)
				await record(tx, { kind: 'link', dirIno, name, ino, type: meta.type }, options)
			})

			emit({ ino, kind: 'meta', source: options?.origin })
			emit({ ino, kind: 'dirent', dirIno, name, path, source: options?.origin })
			return ino
		},

		async atomicMove(
			oldDirIno: Ino,
			oldName: string,
			newDirIno: Ino,
			newName: string,
			options?: MutationOptions
		): Promise<Ino | null> {
			await ensureBootstrapped()
			let displaced: Ino | null = null
			let movedIno: Ino | null = null
			let oldPath: string | undefined
			let newPath: string | undefined
			const orphanedR2Keys: string[] = []

			await db.transaction(async (tx) => {
				await ensureDirectory(tx, oldDirIno)
				await ensureDirectory(tx, newDirIno)

				if (oldDirIno === newDirIno && oldName === newName) return

				const source = await getDirent(tx, oldDirIno, oldName)
				if (!source) throw new Error(`ENOENT: ${oldName}`)

				const destination = await getDirent(tx, newDirIno, newName)
				if (destination && String(destination.ino) === String(source.ino)) return

				// Both parents' paths, for the change feed below (and the same ENOENT a
				// move out of / into an unlinked directory has always raised).
				const oldDirPath = await pathOf(tx, oldDirIno)
				const newDirPath = await pathOf(tx, newDirIno)
				if (oldDirPath === null || newDirPath === null) throw new Error('ENOENT: parent')
				oldPath = joinPath(oldDirPath, oldName)
				newPath = joinPath(newDirPath, newName)

				if (destination) {
					displaced = String(destination.ino)
					await tx.run('DELETE FROM fs_dirents WHERE dir_ino = ? AND name = ?', [
						newDirIno,
						newName
					])
					await deleteInodeInTx(tx, String(destination.ino), orphanedR2Keys)
				}

				await tx.run('UPDATE fs_dirents SET dir_ino = ?, name = ? WHERE dir_ino = ? AND name = ?', [
					newDirIno,
					newName,
					oldDirIno,
					oldName
				])
				movedIno = String(source.ino)
				// ONE effect, however big the subtree is — what recording it costs is the
				// observer's call, not this backend's.
				await record(
					tx,
					{
						kind: 'move',
						fromDirIno: oldDirIno,
						fromName: oldName,
						toDirIno: newDirIno,
						toName: newName,
						ino: movedIno,
						displaced
					},
					options
				)
			})

			await deleteBlobs(orphanedR2Keys)

			if (displaced !== null) emit({ ino: displaced, kind: 'meta', source: options?.origin })
			if (movedIno !== null) {
				emit({
					ino: movedIno,
					kind: 'dirent',
					dirIno: newDirIno,
					name: newName,
					path: newPath,
					source: options?.origin
				})
				emit({
					ino: movedIno,
					kind: 'dirent',
					dirIno: oldDirIno,
					name: oldName,
					path: oldPath,
					source: options?.origin
				})
			}
			return displaced
		},

		async fullScan(cursor: string) {
			await ensureBootstrapped()
			// `tree.path > ''` holds for every path (a dirent name is never empty), so the
			// first page needs no separate query.
			const rows = await db.query<TreeRow>(
				`${TREE_CTE}
					SELECT
						tree.path,
						tree.ino,
						tree.dir_ino,
						tree.name,
						inode.type,
						inode.mode,
						inode.size,
						inode.mtime_ns,
						inode.ctime_ns,
						inode.content_hash,
						inode.symlink_target
					FROM tree
					JOIN fs_inodes inode ON inode.ino = tree.ino
					WHERE tree.path > ?
					ORDER BY tree.path
					LIMIT ?`,
				[ROOT_INO, FileType.Directory, cursor, SCAN_PAGE_SIZE]
			)

			const xattrsByIno = await readXattrsByIno(
				db,
				rows.filter((row) => toNumber(row.type) === FileType.Regular).map((row) => String(row.ino))
			)

			return {
				entries: rows.map((row) => {
					const ino = String(row.ino)
					const xattrs = xattrsByIno.get(ino)
					return {
						ino,
						dirIno: String(row.dir_ino),
						name: String(row.name),
						meta: {
							type: toNumber(row.type) as FileType,
							size: toBigInt(row.size),
							mode: toNumber(row.mode),
							mtimeNs: toBigInt(row.mtime_ns),
							ctimeNs: toBigInt(row.ctime_ns),
							contentHash: toStringOrNull(row.content_hash) ?? undefined,
							symlinkTarget: toStringOrNull(row.symlink_target) ?? undefined
						},
						...(xattrs && Object.keys(xattrs).length > 0 ? { xattrs } : {})
					}
				}),
				next: rows.length === SCAN_PAGE_SIZE ? String(rows[rows.length - 1].path) : ''
			}
		},

		// The sync snapshot, read from the tree instead of replayed from the journal
		// (see PathSnapshotStore). Both halves are keyset-paged by canonical path and
		// return a short page ONLY at the end — `treeChangeSource` reads a short page as
		// the end of a phase, so no filtering may happen after the LIMIT.
		pathSnapshot: {
			async puts(after: string, limit: number): Promise<PathChange[]> {
				await ensureBootstrapped()
				// The version is joined onto the PAGE, never inside the recursive CTE: the
				// CTE walks the tree and the join would be re-evaluated at every step of it.
				// A path with no version row was created by tree repair (`ensureDirPath`
				// resurrecting a deleted ancestor), which mints no version — 0 loses every
				// LWW compare, which is the right answer for a directory the receiving
				// replica will recreate from its children anyway.
				//
				// A regular file with no contentHash is excluded HERE, in SQL, for the same
				// reason the journal never carries one (see `buildPutChange`): a wire put
				// must be hydratable. Doing it after the LIMIT would shorten the page and
				// read as the end of the snapshot.
				const rows = await db.query<TreeRow & { version: unknown }>(
					`${TREE_CTE},
					page AS (
						SELECT
							tree.path AS path,
							tree.ino AS ino,
							tree.dir_ino AS dir_ino,
							tree.name AS name,
							inode.type AS type,
							inode.mode AS mode,
							inode.size AS size,
							inode.mtime_ns AS mtime_ns,
							inode.ctime_ns AS ctime_ns,
							inode.content_hash AS content_hash,
							inode.symlink_target AS symlink_target
						FROM tree
						JOIN fs_inodes inode ON inode.ino = tree.ino
						WHERE tree.path > ?
						  AND (inode.type <> ? OR inode.content_hash IS NOT NULL)
						ORDER BY tree.path
						LIMIT ?
					)
					SELECT page.*, version.version
					FROM page
					LEFT JOIN fs_path_version version ON version.path = '/' || page.path
					ORDER BY page.path`,
					[
						ROOT_INO,
						FileType.Directory,
						// The cursor is canonical; the CTE's paths are relative.
						after.startsWith('/') ? after.slice(1) : after,
						FileType.Regular,
						limit
					]
				)
				const xattrs = await readXattrsByIno(
					db,
					rows.map((row) => String(row.ino))
				)
				return rows.flatMap((row) => {
					const path = `/${String(row.path)}`
					const change = buildPutChange(
						path,
						{
							type: toNumber(row.type) as FileType,
							size: toBigInt(row.size),
							mode: toNumber(row.mode),
							mtimeNs: toBigInt(row.mtime_ns),
							ctimeNs: toBigInt(row.ctime_ns),
							contentHash: toStringOrNull(row.content_hash) ?? undefined,
							symlinkTarget: toStringOrNull(row.symlink_target) ?? undefined
						},
						xattrs.get(String(row.ino)) ?? {},
						toNumber(row.version ?? 0),
						localActorId
					)
					return change ? [change] : []
				})
			},
			async tombstones(after: string, limit: number): Promise<PathChange[]> {
				await ensureBootstrapped()
				// `tombstone_version >= version` is what "currently deleted" means here: a
				// local put always mints a version ABOVE the tombstone high-water
				// (`nextVersion`), and an applied remote put only fast-forwards `version`.
				// So a resurrected path sorts out of this set and back into `puts`.
				const rows = await db.query<{ path: unknown; tombstone_version: unknown }>(
					`SELECT path, tombstone_version FROM fs_path_version
					 WHERE tombstone_version > 0 AND tombstone_version >= version AND path > ?
					 ORDER BY path
					 LIMIT ?`,
					[after, limit]
				)
				return rows.map((row) =>
					buildDeleteChange(String(row.path), toNumber(row.tombstone_version), localActorId)
				)
			}
		},

		// ── Path-sync seams ───────────────────────────────────────────────────
		//
		// SQLITE PATH-SYNC EPIC — remaining slices (one commit each; reference impl in
		// @justfiles/sync, specified by `pathSyncConformanceCases`):
		//
		//   1. [DONE] caps.content — hash-addressed blob store (below).
		//   2. [DONE] caps.subscribe — in-memory change feed + emit() on every committed
		//      mutation (below + emit() in setMeta/putBlob/putDirent/deleteDirent/
		//      atomicCreate/atomicMove/deleteInode), so a volume over sqlite invalidates
		//      its cache when applyJournaled writes directly (the 1edbd53d stale-cache fix).
		//   3. [DONE] schema (0002_path_sync.sql: fs_path_journal + fs_path_version) +
		//      pathOf (recursive CTE) + journalPut/journalDelete wired into each
		//      single-file mutation's txn (atomicCreate, putDirent, putBlob, setMeta,
		//      deleteDirent) + the journal store (append/readFrom/head) below. Regular
		//      files journal on putBlob once hashed (buildPutChange returns null before).
		//   4. [DONE] pathApply.applyJournaled + localChange (below): apply remote
		//      changes in ONE txn (ensure parent dirs — resurrecting deleted ancestors,
		//      upsert inode meta + contentHash ref, set/delete dirent, replace user
		//      xattrs, append the journal row VERBATIM + localSource, fast-forward
		//      fs_path_version), emit() per change so the volume cache invalidates;
		//      localChange reconstructs the path's current PathChange for the LWW.
		//   5. [DONE] atomicMove subtree journaling (above): ordered delete(old subtree,
		//      child-first) + put(new subtree, parent-first), enumerated via a recursive
		//      CTE (enumerateSubtree). Moved regular files re-emit a put referencing the
		//      already-present bytes. => rename conformance GREEN; sqlite is the first
		//      fully-proven shipping backend for path-based sync (5/5).
		//
		// caps.subscribe: the change feed fires after each mutation's txn commits.
		subscribe(listener: (change: StorageChange) => void): () => void {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},

		// Drop local sync state (journal + version generator) for a client reset.
		// Tree + content are left intact.
		async clearSyncState(): Promise<void> {
			await ensureBootstrapped()
			await db.transaction(async (tx) => {
				await tx.run('DELETE FROM fs_path_journal')
				await tx.run('DELETE FROM fs_path_version')
			})
		},

		// Hash-addressed content store (matching R2 / the mem backend): the inode
		// holds a `contentHash` reference and the bytes live in `fs_contents`, keyed
		// by that hash. Thin wrapper over the already-content-addressed table — the
		// local SyncReplica's BlobStore reads/writes it to materialise pulled content
		// out-of-band. The caller supplies the hash (it is content-addressed by their
		// digest); we trust it, exactly as `mem` does.
		content: {
			async hasByHash(hash: string): Promise<boolean> {
				await ensureBootstrapped()
				const rows = await db.query<{ present: unknown }>(
					'SELECT 1 AS present FROM fs_contents WHERE content_hash = ? LIMIT 1',
					[hash]
				)
				return rows.length > 0
			},
			async getByHash(hash: string): Promise<Uint8Array | null> {
				await ensureBootstrapped()
				const content = await loadContentRow(db, hash)
				if (!content) return null
				if (toNumber(content.storage_kind) === STORAGE_INLINE)
					return toUint8Array(content.inline_bytes)
				if (!blobStore) throw new Error(`Blob store not configured for hash: ${hash}`)
				const key = toStringOrNull(content.r2_key)
				if (!key) throw new Error(`Missing R2 key for hash: ${hash}`)
				const object = await blobStore.get(key)
				return object ? new Uint8Array(await object.arrayBuffer()) : null
			},
			async putByHash(hash: string, data: Uint8Array): Promise<void> {
				await ensureBootstrapped()
				await db.transaction(async (tx) => {
					await storeContentIfMissing(tx, hash, data)
				})
			},
			async gcUnreferenced() {
				await ensureBootstrapped()
				const orphanedR2Keys: string[] = []
				let reclaimed = 0
				let done = false
				await db.transaction(async (tx) => {
					// Coalesce the journal to the newest row per path, one WINDOW of paths at
					// a time, resuming where the last run stopped. `path` is a real column
					// now, so this is a range scan of the (path, seq) index — it reads the
					// window and nothing else, and each path it does find work on costs one
					// indexed delete rather than a JSON parse per row.
					//
					// `appendJournalRow` now coalesces as it writes (#446), so this finds work
					// only in history written before that — a volume that has drained its
					// backlog once walks the window and finds nothing, forever.
					const [cursor] = await tx.query<{ resume: unknown }>(
						'SELECT journal_coalesce_path AS resume FROM fs_generation WHERE id = 1 LIMIT 1'
					)
					const window = await tx.query<{ path: unknown; keep: unknown; held: unknown }>(
						`SELECT path, MAX(seq) AS keep, COUNT(*) AS held
						 FROM fs_path_journal
						 WHERE path > ?
						 GROUP BY path
						 LIMIT ?`,
						[toStringOrNull(cursor?.resume) ?? '', JOURNAL_PRUNE_WINDOW]
					)
					for (const row of window)
						if (toNumber(row.held) > 1)
							await tx.run('DELETE FROM fs_path_journal WHERE path = ? AND seq < ?', [
								String(row.path),
								toNumber(row.keep)
							])
					// A short window is the end of the journal: the pass is over, so the next
					// run starts a fresh one.
					done = window.length < JOURNAL_PRUNE_WINDOW
					await tx.run('UPDATE fs_generation SET journal_coalesce_path = ? WHERE id = 1', [
						done ? '' : String(window[window.length - 1]?.path ?? '')
					])
					// Nothing below runs until a pass over the journal finishes — a THROTTLE,
					// not a barrier. The content scan below is a full pass over `fs_contents`,
					// which a continuation would wake for every 60s; once per pass is enough.
					// The tombstone sweep wants the same gate for a reason of its own (see
					// `sweepTombstones`).
					//
					// It is deliberately not written as "collect only while no superseded row
					// survives". That would read as a guarantee it cannot give: an overwrite
					// already drops the superseded bytes inline, in its own transaction, while
					// the journal row naming them waits for the prune (#446). Nothing here
					// makes such a row safe to serve, and no ordering of these sweeps can.
					if (!done) return
					const rows = await tx.query<{ content_hash: unknown }>(
						`SELECT content_hash FROM fs_contents
						 WHERE content_hash NOT IN (SELECT content_hash FROM fs_inodes WHERE content_hash IS NOT NULL)`
					)
					for (const row of rows) {
						await maybeDeleteOrphanedContent(tx, String(row.content_hash), orphanedR2Keys)
						reclaimed++
					}
					done = await sweepTombstones(tx)
				})
				await deleteBlobs(orphanedR2Keys)
				return { reclaimed, done }
			}
		},
		journal: {
			async append(changes: PathChange[], localSource?: string) {
				await ensureBootstrapped()
				await db.transaction(async (tx) => {
					for (const change of changes) await appendJournalRow(tx, change, localSource)
				})
			},
			async readFrom(seq: number, limit: number) {
				await ensureBootstrapped()
				const rows = await db.query<{
					seq: unknown
					local_source: unknown
					change_json: unknown
				}>(
					'SELECT seq, local_source, change_json FROM fs_path_journal WHERE seq > ? ORDER BY seq LIMIT ?',
					[seq, limit]
				)
				return rows.map((row) => ({
					seq: toNumber(row.seq),
					change: JSON.parse(String(row.change_json)) as PathChange,
					localSource: toStringOrNull(row.local_source) ?? undefined
				}))
			},
			async head() {
				await ensureBootstrapped()
				// Never below the floor. `MAX(seq)` alone can sit UNDER it — collect a path
				// deleted at seq 50 while a live path's only row is seq 10, and the journal's
				// head is 10 — so a bootstrap would hand back a resume cursor that its own
				// next pull refuses as pruned, and the replica would re-bootstrap forever.
				// Everything up to the floor is already accounted for by the snapshot.
				const [row] = await db.query<{ head: unknown }>(
					`SELECT MAX(
						(SELECT COALESCE(MAX(seq), 0) FROM fs_path_journal),
						COALESCE((SELECT journal_pruned_below FROM fs_generation WHERE id = 1), 0)
					 ) AS head`
				)
				return toNumber(row?.head ?? 0)
			},
			async prunedBelow() {
				await ensureBootstrapped()
				const [row] = await db.query<{ floor: unknown }>(
					'SELECT journal_pruned_below AS floor FROM fs_generation WHERE id = 1 LIMIT 1'
				)
				return toNumber(row?.floor ?? 0)
			},
			// One-time reset/migration path: the full journal is intentionally read
			// in memory so only its latest state is republished.
			async adoptAllAsLocal(opts?: { dropDeletes?: boolean }) {
				await ensureBootstrapped()
				await db.transaction(async (tx) => {
					const rows = await tx.query<{ change_json: unknown }>(
						'SELECT change_json FROM fs_path_journal ORDER BY seq'
					)
					const current = coalesceByPath(
						rows.map((row) => JSON.parse(String(row.change_json)) as PathChange)
					).filter((change) => !opts?.dropDeletes || change.kind === 'put')
					await tx.run('DELETE FROM fs_path_journal')
					for (const change of current) await appendJournalRow(tx, change)
				})
			}
		},
		pathApply: {
			async localChange(path: string): Promise<PathChange | null> {
				// Current local durable state at `path`, for the engine's LWW compare (a
				// linked path's put, else a tombstone's delete, else null). Reads only, so
				// it binds the port to `db` rather than opening a transaction.
				await ensureBootstrapped()
				const { tree, sync } = makePathPorts(db)
				return localChangeOver(tree, sync, path, localActorId)
			},
			async applyJournaled(changes: PathChange[], opts: { localSource?: string }): Promise<void> {
				// Remote-authored apply in ONE txn (shared driver over the sqlite port).
				// emit() fires AFTER commit so a volume over sqlite invalidates its cache on
				// the pull; NEVER writes blob bytes; NEVER GCs blob content on delete.
				await ensureBootstrapped()
				let pendingEmits: StorageChange[] = []
				await db.transaction(async (tx) => {
					const bound = makePathPorts(tx)
					pendingEmits = bound.emits
					await applyJournaledOver(bound.tree, bound.sync, changes, opts)
				})
				for (const change of pendingEmits) emit(change)
			}
		}
	} satisfies StorageCapabilities & JournaledSyncModule
	const { clearSyncState, journal, pathApply, pathSnapshot, ...caps } = implemented
	const sync: JournaledSyncModule = { clearSyncState, journal, pathApply, pathSnapshot }

	// ── Storage implementation ─────────────────────────────────────────

	const filesystem: JournaledStorage = {
		rootIno: ROOT_INO,
		caps,
		sync,

		async getMeta(ino: Ino) {
			await ensureBootstrapped()
			const row = await getInode(db, ino)
			return row ? metaFromRow(row) : null
		},

		async setMeta(ino: Ino, partial: Partial<InodeMeta>, options?: MutationOptions) {
			await ensureBootstrapped()
			let changed = false
			await db.transaction(async (tx) => {
				const row = await getInode(tx, ino)
				if (!row) {
					const created = buildMissingInodeMeta(partial)
					if (!created) return
					await tx.run(
						`INSERT INTO fs_inodes(
							ino, type, mode, size, mtime_ns, ctime_ns, content_hash, symlink_target, mime_type, storage_kind
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
						[
							ino,
							created.type,
							created.mode,
							Number(created.size),
							created.mtimeNs,
							created.ctimeNs,
							created.contentHash ?? null,
							created.symlinkTarget ?? null,
							STORAGE_NONE
						]
					)
					changed = true
					return
				}
				const current = metaFromRow(row)
				const next: InodeMeta = { ...current, ...partial }
				await tx.run(
					`UPDATE fs_inodes
					 SET type = ?, mode = ?, size = ?, mtime_ns = ?, ctime_ns = ?, content_hash = ?, symlink_target = ?
					 WHERE ino = ?`,
					[
						next.type,
						next.mode,
						Number(next.size),
						next.mtimeNs,
						next.ctimeNs,
						next.contentHash ?? null,
						next.symlinkTarget ?? null,
						ino
					]
				)
				changed = true
				await record(tx, { kind: 'meta', ino }, options)
			})
			if (changed) emit({ ino, kind: 'meta', source: options?.origin })
		},

		async deleteInode(ino: Ino) {
			await ensureBootstrapped()
			const orphanedR2Keys: string[] = []
			let deleted = false
			await db.transaction(async (tx) => {
				const inode = await getInode(tx, ino)
				if (!inode || (await hasDirentReference(tx, ino))) return
				await deleteInodeInTx(tx, ino, orphanedR2Keys)
				deleted = true
			})
			await deleteBlobs(orphanedR2Keys)
			if (deleted) emit({ ino, kind: 'meta' })
		},

		async getBlob(ino: Ino) {
			await ensureBootstrapped()
			return readFullContent(db, ino)
		},

		async putBlob(ino: Ino, data: Uint8Array, options?: MutationOptions) {
			await updateInodeContent(ino, data, options)
		},

		async getDirent(dirIno: Ino, name: string) {
			await ensureBootstrapped()
			const [row] = await db.query<DirentRow>(
				`SELECT dirent.dir_ino, dirent.name, dirent.ino, dirent.type
				 FROM fs_dirents AS dirent
				 JOIN fs_inodes AS inode ON inode.ino = dirent.ino
				 WHERE dirent.dir_ino = ? AND dirent.name = ?
				 LIMIT 1`,
				[dirIno, name]
			)
			return row ? { ino: String(row.ino), type: toNumber(row.type) as FileType } : null
		},

		async putDirent(
			dirIno: Ino,
			name: string,
			entry: { ino: Ino; type: FileType },
			options?: MutationOptions
		) {
			await ensureBootstrapped()
			let path: string | undefined
			await db.transaction(async (tx) => {
				await ensureDirentTarget(tx, dirIno, entry)
				const existing = await getDirent(tx, dirIno, name)
				if (existing) {
					await tx.run('UPDATE fs_dirents SET ino = ?, type = ? WHERE dir_ino = ? AND name = ?', [
						entry.ino,
						entry.type,
						dirIno,
						name
					])
				} else {
					await tx.run('INSERT INTO fs_dirents(dir_ino, name, ino, type) VALUES (?, ?, ?, ?)', [
						dirIno,
						name,
						entry.ino,
						entry.type
					])
				}
				const dirPath = await pathOf(tx, dirIno)
				if (dirPath !== null) path = joinPath(dirPath, name)
				await record(tx, { kind: 'link', dirIno, name, ino: entry.ino, type: entry.type }, options)
			})
			emit({ ino: entry.ino, kind: 'dirent', dirIno, name, path, source: options?.origin })
		},

		async deleteDirent(dirIno: Ino, name: string, options?: MutationOptions) {
			await ensureBootstrapped()
			let removedIno: Ino | null = null
			let path: string | undefined
			await db.transaction(async (tx) => {
				const existing = await getDirent(tx, dirIno, name)
				if (!existing) return
				removedIno = String(existing.ino)
				await tx.run('DELETE FROM fs_dirents WHERE dir_ino = ? AND name = ?', [dirIno, name])
				const dirPath = await pathOf(tx, dirIno)
				if (dirPath !== null) path = joinPath(dirPath, name)
				await record(tx, { kind: 'unlink', dirIno, name, ino: removedIno }, options)
			})
			if (removedIno !== null)
				emit({ ino: removedIno, kind: 'dirent', dirIno, name, path, source: options?.origin })
		},

		async listDirents(dirIno: Ino, cursor: string) {
			await ensureBootstrapped()
			const rows =
				cursor === ''
					? await db.query<DirentRow>(
							`SELECT dirent.dir_ino, dirent.name, dirent.ino, dirent.type
						 FROM fs_dirents AS dirent
						 JOIN fs_inodes AS inode ON inode.ino = dirent.ino
						 WHERE dirent.dir_ino = ?
						 ORDER BY dirent.name
						 LIMIT ?`,
							[dirIno, DIR_PAGE_SIZE]
						)
					: await db.query<DirentRow>(
							`SELECT dirent.dir_ino, dirent.name, dirent.ino, dirent.type
						 FROM fs_dirents AS dirent
						 JOIN fs_inodes AS inode ON inode.ino = dirent.ino
						 WHERE dirent.dir_ino = ? AND dirent.name > ?
						 ORDER BY dirent.name
						 LIMIT ?`,
							[dirIno, cursor, DIR_PAGE_SIZE]
						)

			return {
				entries: rows.map((row) => ({
					name: String(row.name),
					ino: String(row.ino),
					type: toNumber(row.type) as FileType
				})),
				next: rows.length === DIR_PAGE_SIZE ? String(rows[rows.length - 1].name) : ''
			}
		}
	}

	const nodeModule: NodeSyncModule = {
		nodes: makeNodeStore(db),
		async apply(operations, opts) {
			await ensureBootstrapped()
			const preparedContent = new Map<string, { data: Uint8Array; staged: StagedContent }>()
			for (const [hash, data] of opts?.content ?? []) {
				if (await loadContentRow(db, hash)) continue
				preparedContent.set(hash, { data, staged: await stageContent(hash, data) })
			}
			let pendingEmits: StorageChange[] = []
			await db.transaction(async (tx) => {
				const bound = makePathPorts(tx, preparedContent)
				pendingEmits = bound.emits
				await applyNodeOperationsOver(bound.tree, makeNodeStore(tx), operations, opts)
			})
			for (const change of pendingEmits) emit(change)
		},
		async openSnapshotView() {
			await ensureBootstrapped()
			let entries: ReturnType<typeof nodeSnapshotEntries> = []
			let syncCursor = '0'
			const blobs = new Map<string, Uint8Array>()
			await db.transaction(async (tx) => {
				const bound = makePathPorts(tx)
				const nodes = makeNodeStore(tx)
				await applyNodeOperationsOver(bound.tree, nodes, [])
				const live = await nodes.live()
				entries = nodeSnapshotEntries(live)
				syncCursor = String(await nodes.head())
				for (const node of live) {
					if (!node.contentHash || node.localIno === null || blobs.has(node.contentHash)) continue
					const blob = await readFullContent(tx, node.localIno)
					if ((await sha256Hex(blob)) !== node.contentHash)
						throw new Error(`hash mismatch for snapshot blob ${node.contentHash}`)
					blobs.set(node.contentHash, blob.slice())
				}
			})
			return {
				entries,
				syncCursor,
				async getBlob(hash: string) {
					const blob = blobs.get(hash)
					if (!blob) throw new Error(`ENOENT: snapshot blob ${hash}`)
					return blob.slice()
				},
				async close() {
					blobs.clear()
				}
			}
		}
	}

	return withSyncCapability(filesystem, createSyncCapability(filesystem, nodeModule))
}
