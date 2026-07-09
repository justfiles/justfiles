import {
	FsCursorExpiredError,
	type FsOp,
	type InodeMeta,
	type MutationOptions,
	type Storage,
	type StorageChange,
	type UpdateQueryOptions
} from '@justfiles/fs/storage'
import {
	buildDeleteChange,
	buildPutChange,
	joinPath,
	nextVersion,
	splitPath
} from '@justfiles/fs/storage.shared'
import { inodeMetaFromSync, type PathChange } from '@justfiles/fs/sync-wire'
import type { Ino } from '@justfiles/fs/types'
import { FileType } from '@justfiles/fs/types'
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
	delete?(key: string): Promise<void>
}

type StorageOptions = {
	blobStore?: BlobStore
	namespace?: string
	inlineTextLimitBytes?: number
	maxRetainedUpdates?: number
	/** Default ORIGIN for local writes without an explicit `options.source`. */
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

type UpdateRow = {
	seq: unknown
	op_kind: unknown
	source: unknown
	ino: unknown
	dir_ino: unknown
	name: unknown
	entry_ino: unknown
	entry_type: unknown
	meta_json: unknown
	xattrs_json: unknown
	content_changed: unknown
}

const ROOT_INO: Ino = '1'
const DIR_PAGE_SIZE = 200
const SCAN_PAGE_SIZE = 200
const INLINE_TEXT_LIMIT_BYTES = 256 * 1024
const DEFAULT_MAX_RETAINED_UPDATES = 20_000
const FS_STATE_UPDATES_PRUNED_THROUGH_SEQ = 'updates_pruned_through_seq'
const STORAGE_NONE = 0
const STORAGE_INLINE = 1
const STORAGE_R2 = 2

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

function encodeBytes(value: Uint8Array): string {
	let str = ''
	for (const byte of value) str += String.fromCharCode(byte)
	return btoa(str)
}

function decodeBytes(value: string): Uint8Array {
	let binary = ''
	try {
		binary = atob(value)
	} catch {
		throw new Error('Invalid base64 payload in fs_updates')
	}
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	return bytes
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

function serializeMeta(meta: Partial<InodeMeta>): string {
	const encoded: Record<string, unknown> = {}
	if (meta.type !== undefined) encoded.type = meta.type
	if (meta.size !== undefined) encoded.size = meta.size.toString()
	if (meta.mode !== undefined) encoded.mode = meta.mode
	if (meta.mtimeNs !== undefined) encoded.mtimeNs = meta.mtimeNs.toString()
	if (meta.ctimeNs !== undefined) encoded.ctimeNs = meta.ctimeNs.toString()
	if ('contentHash' in meta) encoded.contentHash = meta.contentHash ?? null
	if ('symlinkTarget' in meta) encoded.symlinkTarget = meta.symlinkTarget ?? null
	return JSON.stringify(encoded)
}

function parseMetaJson(raw: string): Partial<InodeMeta> {
	const parsed = JSON.parse(raw) as Record<string, unknown>
	const meta: Partial<InodeMeta> = {}
	if (parsed.type !== undefined) meta.type = Number(parsed.type) as FileType
	if (parsed.size !== undefined) meta.size = BigInt(String(parsed.size))
	if (parsed.mode !== undefined) meta.mode = Number(parsed.mode)
	if (parsed.mtimeNs !== undefined) meta.mtimeNs = BigInt(String(parsed.mtimeNs))
	if (parsed.ctimeNs !== undefined) meta.ctimeNs = BigInt(String(parsed.ctimeNs))
	if ('contentHash' in parsed)
		meta.contentHash = parsed.contentHash == null ? undefined : String(parsed.contentHash)
	if ('symlinkTarget' in parsed)
		meta.symlinkTarget = parsed.symlinkTarget == null ? undefined : String(parsed.symlinkTarget)
	return meta
}

function withSource(ops: FsOp[], options?: MutationOptions): FsOp[] {
	if (!options?.source) return ops
	return ops.map((op) => ({ ...op, source: options.source }))
}

function filterOpsBySource(ops: FsOp[], options?: UpdateQueryOptions): FsOp[] {
	const source = options?.source
	const mode = options?.sourceMode ?? 'only'
	if (!source) return ops
	return ops.filter((op) => (mode === 'exclude' ? op.source !== source : op.source === source))
}

function serializeXattrs(xattrs: Record<string, Uint8Array | null>): string {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(xattrs).map(([name, value]) => [
				name,
				value === null ? null : encodeBytes(value)
			])
		)
	)
}

function parseXattrsJson(raw: string): Record<string, Uint8Array | null> {
	const parsed = JSON.parse(raw) as Record<string, string | null>
	return Object.fromEntries(
		Object.entries(parsed).map(([name, value]) => [
			name,
			value === null ? null : decodeBytes(value)
		])
	)
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

export function storage(db: DbAdapter, options: StorageOptions = {}): Storage {
	const blobStore = options.blobStore
	const namespace = options.namespace ?? 'default'
	const inlineTextLimit = options.inlineTextLimitBytes ?? INLINE_TEXT_LIMIT_BYTES
	const maxRetainedUpdates = options.maxRetainedUpdates ?? DEFAULT_MAX_RETAINED_UPDATES
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

	async function getStateNumber(tx: DbAdapter, key: string): Promise<number> {
		const [row] = await tx.query<{ value: unknown }>(
			'SELECT value FROM fs_state WHERE key = ? LIMIT 1',
			[key]
		)
		const parsed = row?.value == null ? 0 : Number.parseInt(String(row.value), 10)
		return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
	}

	async function setStateNumber(tx: DbAdapter, key: string, value: number): Promise<void> {
		await tx.run(
			`INSERT INTO fs_state(key, value) VALUES(?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			[key, String(value)]
		)
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

		const textInfo = inferText(data, inlineTextLimit)
		if (!blobStore || textInfo) {
			const mimeType = textInfo?.mimeType ?? 'application/octet-stream'
			const textEncoding = textInfo ? 'utf-8' : null
			await tx.run(
				`INSERT INTO fs_contents(
					content_hash, storage_kind, size, inline_bytes, inline_text, r2_key, mime_type, text_encoding, created_at_ns
				) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
				[
					contentHash,
					STORAGE_INLINE,
					data.length,
					data,
					textInfo?.text ?? null,
					mimeType,
					textEncoding,
					nowNs()
				]
			)
			await insertFtsRow(tx, contentHash, textInfo?.text ?? null)
			return { storageKind: STORAGE_INLINE, mimeType }
		}

		const key = blobKey(contentHash)
		await blobStore.put(key, data, {
			httpMetadata: { contentType: 'application/octet-stream' },
			customMetadata: { namespace, contentHash }
		})
		await tx.run(
			`INSERT INTO fs_contents(
				content_hash, storage_kind, size, inline_bytes, inline_text, r2_key, mime_type, text_encoding, created_at_ns
			) VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, ?)`,
			[contentHash, STORAGE_R2, data.length, key, 'application/octet-stream', nowNs()]
		)
		return { storageKind: STORAGE_R2, mimeType: 'application/octet-stream' }
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

	async function appendOps(tx: DbAdapter, ops: FsOp[]): Promise<void> {
		if (ops.length === 0) return
		const txId = randomId()
		const atNs = nowNs()
		for (let i = 0; i < ops.length; i++) {
			const op = ops[i]
			switch (op.kind) {
				case 'upsert-inode':
					await tx.run(
						`INSERT INTO fs_updates(
							tx_id, op_index, at_ns, op_kind, source, ino, meta_json, xattrs_json, content_changed
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						[
							txId,
							i,
							atNs,
							op.kind,
							op.source ?? null,
							op.ino,
							op.meta ? serializeMeta(op.meta) : null,
							op.xattrs ? serializeXattrs(op.xattrs) : null,
							0
						]
					)
					break
				case 'set-dirent':
					await tx.run(
						`INSERT INTO fs_updates(
							tx_id, op_index, at_ns, op_kind, source, dir_ino, name, entry_ino, entry_type
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						[txId, i, atNs, op.kind, op.source ?? null, op.dirIno, op.name, op.ino, op.type]
					)
					break
				case 'unset-dirent':
					await tx.run(
						`INSERT INTO fs_updates(
							tx_id, op_index, at_ns, op_kind, source, dir_ino, name, entry_ino
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
						[txId, i, atNs, op.kind, op.source ?? null, op.dirIno, op.name, op.ino ?? null]
					)
					break
			}
		}
		await pruneUpdates(tx)
	}

	async function pruneUpdates(tx: DbAdapter): Promise<void> {
		if (maxRetainedUpdates <= 0) return

		const [cutoff] = await tx.query<{ seq: unknown }>(
			'SELECT seq FROM fs_updates ORDER BY seq DESC LIMIT 1 OFFSET ?',
			[maxRetainedUpdates - 1]
		)
		if (!cutoff?.seq) return

		const keepFromSeq = toNumber(cutoff.seq)
		if (!Number.isFinite(keepFromSeq) || keepFromSeq <= 1) return

		const prunedThrough = keepFromSeq - 1
		await tx.run('DELETE FROM fs_updates WHERE seq < ?', [keepFromSeq])

		const previous = await getStateNumber(tx, FS_STATE_UPDATES_PRUNED_THROUGH_SEQ)
		if (prunedThrough > previous) {
			await setStateNumber(tx, FS_STATE_UPDATES_PRUNED_THROUGH_SEQ, prunedThrough)
		}
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
	// row — via the shared PURE builders (storage.shared.ts) — inside its OWN
	// transaction, with a version from fs_path_version and ORIGIN =
	// options.source ?? localActorId. Mirrors the memStorage reference impl.

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
		await tx.run('INSERT INTO fs_path_journal(local_source, change_json) VALUES (?, ?)', [
			localSource ?? null,
			JSON.stringify(change)
		])
	}

	/** Journal a `put` for a linked path; self-skips a fresh regular file (no contentHash yet). */
	async function journalPut(
		tx: DbAdapter,
		path: string,
		ino: Ino,
		options?: MutationOptions
	): Promise<void> {
		const row = await getInode(tx, ino)
		if (!row) return
		const meta = metaFromRow(row)
		const xattrs = await listAllXattrs(tx, ino)
		const cur = await readPathVersion(tx, path)
		// An explicit options.version pins the outgoing version exactly (up OR down);
		// otherwise generate the next one. See MutationOptions.
		const version = options?.version ?? nextVersion(cur.version, cur.tombstone)
		const change = buildPutChange(path, meta, xattrs, version, options?.source ?? localActorId)
		if (!change) return
		await setPathVersion(tx, path, version, cur.tombstone)
		await appendJournalRow(tx, change)
	}

	/** Journal a `delete` for a path and fast-forward its tombstone high-water mark. */
	async function journalDelete(
		tx: DbAdapter,
		path: string,
		options?: MutationOptions
	): Promise<void> {
		const cur = await readPathVersion(tx, path)
		const version = nextVersion(cur.version, cur.tombstone)
		await setPathVersion(tx, path, version, Math.max(cur.tombstone, version))
		await appendJournalRow(tx, buildDeleteChange(path, version, options?.source ?? localActorId))
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

	// Upsert an inode from a remote put's SyncMeta: tree metadata + the contentHash
	// REFERENCE (bytes are materialised out-of-band by applyPathChanges), and REPLACE
	// the user-xattr set with the wire snapshot (local-only trusted.sync.* untouched).
	// ctime is set locally (0, matching the mem reference), never wired.
	async function upsertInodeFromSync(tx: DbAdapter, ino: Ino, change: PathChange): Promise<void> {
		if (change.kind !== 'put') return
		const { meta, xattrs: snapshot } = inodeMetaFromSync(change.meta)
		const type = meta.type ?? FileType.Regular
		await tx.run(
			`INSERT INTO fs_inodes(ino, type, mode, size, mtime_ns, ctime_ns, content_hash, symlink_target, mime_type, storage_kind)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
			 ON CONFLICT(ino) DO UPDATE SET
			   type = excluded.type, mode = excluded.mode, size = excluded.size,
			   mtime_ns = excluded.mtime_ns, ctime_ns = excluded.ctime_ns,
			   content_hash = excluded.content_hash, symlink_target = excluded.symlink_target`,
			[
				ino,
				type,
				meta.mode ?? defaultModeForType(type),
				Number(meta.size ?? 0n),
				meta.mtimeNs ?? 0n,
				0n,
				change.contentHash ?? null,
				meta.symlinkTarget ?? null,
				STORAGE_NONE
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
			const currentMeta = metaFromRow(inode)
			const stamp = nowNs()

			await tx.run(
				`UPDATE fs_inodes
				 SET size = ?, content_hash = ?, mime_type = ?, storage_kind = ?, mtime_ns = ?, ctime_ns = ?
				 WHERE ino = ?`,
				[data.length, contentHash, mimeType, storageKind, stamp, stamp, ino]
			)

			await maybeDeleteOrphanedContent(tx, toStringOrNull(inode.content_hash), orphanedR2Keys)

			const nextMeta: InodeMeta = {
				...currentMeta,
				size: BigInt(data.length),
				mtimeNs: stamp,
				ctimeNs: stamp,
				contentHash
			}
			await appendOps(
				tx,
				withSource(
					[
						{
							kind: 'upsert-inode',
							ino,
							meta: nextMeta
						}
					],
					options
				)
			)
			const path = await pathOf(tx, ino)
			if (path !== null) await journalPut(tx, path, ino, options)
		})

		emit({ ino, kind: 'content', source: options?.source })
		if (blobStore?.delete) {
			for (const key of orphanedR2Keys) {
				await blobStore.delete(key)
			}
		}
	}

	// ── StorageCapabilities ──────────────────────────────────────────────────────

	const caps = {
		async getXattr(ino: Ino, name: string): Promise<Uint8Array | null> {
			await ensureBootstrapped()
			const rows = await db.query<{ value: unknown }>(
				'SELECT value FROM fs_xattrs WHERE ino = ? AND name = ? LIMIT 1',
				[ino, name]
			)
			if (rows.length === 0) return null
			return toUint8Array(rows[0].value)
		},

		async setXattr(
			ino: Ino,
			name: string,
			value: Uint8Array,
			options?: MutationOptions
		): Promise<void> {
			await ensureBootstrapped()
			await db.transaction(async (tx) => {
				const inode = await getInode(tx, ino)
				if (!inode) throw new Error(`ENOENT: ${ino}`)
				await tx.run(
					`INSERT INTO fs_xattrs(ino, name, value) VALUES (?, ?, ?)
					 ON CONFLICT(ino, name) DO UPDATE SET value = excluded.value`,
					[ino, name, value]
				)
				const xattrs = await listAllXattrs(tx, ino)
				await appendOps(
					tx,
					withSource(
						[
							{
								kind: 'upsert-inode',
								ino,
								meta: metaFromRow(inode),
								xattrs
							} as FsOp
						],
						options
					)
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

		async removeXattr(ino: Ino, name: string, options?: MutationOptions): Promise<void> {
			await ensureBootstrapped()
			await db.transaction(async (tx) => {
				const inode = await getInode(tx, ino)
				if (!inode) throw new Error(`ENOENT: ${ino}`)
				await tx.run('DELETE FROM fs_xattrs WHERE ino = ? AND name = ?', [ino, name])
				const xattrs = await listAllXattrs(tx, ino)
				await appendOps(
					tx,
					withSource(
						[
							{
								kind: 'upsert-inode',
								ino,
								meta: metaFromRow(inode),
								xattrs
							} as FsOp
						],
						options
					)
				)
			})
		},

		async atomicCreate(
			dirIno: Ino,
			name: string,
			meta: InodeMeta,
			options?: MutationOptions
		): Promise<Ino> {
			await ensureBootstrapped()
			const ino = randomId()
			const stamp = nowNs()
			const size = meta.type === FileType.Regular ? 0 : Number(meta.size)

			await db.transaction(async (tx) => {
				await ensureDirectory(tx, dirIno)
				const existing = await getDirent(tx, dirIno, name)
				if (existing) throw new Error(`EEXIST: ${name}`)

				await tx.run(
					`INSERT INTO fs_inodes(
						ino, type, mode, size, mtime_ns, ctime_ns, content_hash, symlink_target, mime_type, storage_kind
					) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
					[
						ino,
						meta.type,
						meta.mode,
						size,
						meta.mtimeNs ?? stamp,
						meta.ctimeNs ?? stamp,
						meta.symlinkTarget ?? null,
						STORAGE_NONE
					]
				)
				await tx.run('INSERT INTO fs_dirents(dir_ino, name, ino, type) VALUES (?, ?, ?, ?)', [
					dirIno,
					name,
					ino,
					meta.type
				])
				await appendOps(
					tx,
					withSource(
						[
							{ kind: 'upsert-inode', ino, meta } as FsOp,
							{ kind: 'set-dirent', dirIno, name, ino, type: meta.type } as FsOp
						],
						options
					)
				)
				const dirPath = await pathOf(tx, dirIno)
				if (dirPath !== null) await journalPut(tx, joinPath(dirPath, name), ino, options)
			})

			emit({ ino, kind: 'meta', source: options?.source })
			emit({ ino, kind: 'dirent', dirIno, name, source: options?.source })
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
			const orphanedR2Keys: string[] = []

			await db.transaction(async (tx) => {
				await ensureDirectory(tx, oldDirIno)
				await ensureDirectory(tx, newDirIno)

				if (oldDirIno === newDirIno && oldName === newName) return

				const source = await getDirent(tx, oldDirIno, oldName)
				if (!source) throw new Error(`ENOENT: ${oldName}`)

				const destination = await getDirent(tx, newDirIno, newName)
				if (destination && String(destination.ino) === String(source.ino)) return

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
				// TODO(path-sync) [epic slice 5]: journal the move as an ordered
				// delete(old subtree, child-first) + put(new subtree, parent-first),
				// enumerated via a recursive CTE. Single-file mutations journal in
				// slice 3; rename subtree journaling lands in slice 5.

				await appendOps(
					tx,
					withSource(
						[
							{
								kind: 'set-dirent',
								dirIno: newDirIno,
								name: newName,
								ino: String(source.ino),
								type: toNumber(source.type) as FileType
							},
							{
								kind: 'unset-dirent',
								dirIno: oldDirIno,
								name: oldName,
								ino: String(source.ino)
							}
						],
						options
					)
				)
			})

			if (blobStore?.delete) {
				for (const key of orphanedR2Keys) {
					await blobStore.delete(key)
				}
			}

			if (displaced !== null) emit({ ino: displaced, kind: 'meta', source: options?.source })
			if (movedIno !== null) {
				emit({
					ino: movedIno,
					kind: 'dirent',
					dirIno: newDirIno,
					name: newName,
					source: options?.source
				})
				emit({
					ino: movedIno,
					kind: 'dirent',
					dirIno: oldDirIno,
					name: oldName,
					source: options?.source
				})
			}
			return displaced
		},

		async fullScan(cursor: string) {
			await ensureBootstrapped()
			const [headRow] = await db.query<{ seq: unknown }>(
				'SELECT seq FROM fs_updates ORDER BY seq DESC LIMIT 1'
			)
			const headCursor = headRow?.seq == null ? undefined : String(headRow.seq)
			const rows =
				cursor === ''
					? await db.query<{
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
						}>(
							`WITH RECURSIVE tree(path, ino, dir_ino, name) AS (
							SELECT name, ino, dir_ino, name
							FROM fs_dirents
							WHERE dir_ino = ?
							UNION ALL
							SELECT tree.path || '/' || child.name, child.ino, child.dir_ino, child.name
							FROM tree
							JOIN fs_inodes inode ON inode.ino = tree.ino
							JOIN fs_dirents child ON child.dir_ino = tree.ino
							WHERE inode.type = ?
						)
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
						ORDER BY tree.path
						LIMIT ?`,
							[ROOT_INO, FileType.Directory, SCAN_PAGE_SIZE]
						)
					: await db.query<{
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
						}>(
							`WITH RECURSIVE tree(path, ino, dir_ino, name) AS (
							SELECT name, ino, dir_ino, name
							FROM fs_dirents
							WHERE dir_ino = ?
							UNION ALL
							SELECT tree.path || '/' || child.name, child.ino, child.dir_ino, child.name
							FROM tree
							JOIN fs_inodes inode ON inode.ino = tree.ino
							JOIN fs_dirents child ON child.dir_ino = tree.ino
							WHERE inode.type = ?
						)
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

			// Fetch xattrs for all inodes in this page in one query.
			const fileInos = rows
				.filter((row) => toNumber(row.type) === FileType.Regular)
				.map((row) => String(row.ino))
			const xattrsByIno = new Map<string, Record<string, Uint8Array>>()
			if (fileInos.length > 0) {
				const placeholders = fileInos.map(() => '?').join(', ')
				const xattrRows = await db.query<{ ino: unknown; name: unknown; value: unknown }>(
					`SELECT ino, name, value FROM fs_xattrs WHERE ino IN (${placeholders})`,
					fileInos
				)
				for (const row of xattrRows) {
					const ino = String(row.ino)
					if (!xattrsByIno.has(ino)) xattrsByIno.set(ino, {})
					const xattrs = xattrsByIno.get(ino)
					if (xattrs) {
						xattrs[String(row.name)] = toUint8Array(row.value)
					}
				}
			}

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
				next: rows.length === SCAN_PAGE_SIZE ? String(rows[rows.length - 1].path) : '',
				syncCursor: rows.length === SCAN_PAGE_SIZE ? undefined : headCursor
			}
		},

		async deltaUpdates(cursor: string, options?: UpdateQueryOptions) {
			await ensureBootstrapped()
			const parsedCursor = cursor === '' ? 0 : Number.parseInt(cursor, 10)
			const since = Number.isFinite(parsedCursor) && parsedCursor > 0 ? parsedCursor : 0
			const prunedThroughSeq = await getStateNumber(db, FS_STATE_UPDATES_PRUNED_THROUGH_SEQ)
			if (since > 0 && since < prunedThroughSeq) {
				throw new FsCursorExpiredError(`FS sync cursor expired: ${cursor}`)
			}

			const rows = await db.query<UpdateRow>(
				`SELECT
					seq,
					op_kind,
					source,
					ino,
					dir_ino,
					name,
					entry_ino,
					entry_type,
					meta_json,
					xattrs_json,
					content_changed
				FROM fs_updates
				WHERE seq > ?
				ORDER BY seq ASC`,
				[since]
			)
			const [headRow] = await db.query<{ seq: unknown }>(
				'SELECT seq FROM fs_updates ORDER BY seq DESC LIMIT 1'
			)
			const headCursor = headRow?.seq == null ? cursor : String(headRow.seq)

			const ops = filterOpsBySource(
				rows.map((row) => {
					const opKind = String(row.op_kind)
					switch (opKind) {
						case 'upsert-inode':
							return {
								kind: 'upsert-inode',
								source: toStringOrNull(row.source) ?? undefined,
								ino: String(row.ino),
								meta: row.meta_json ? parseMetaJson(String(row.meta_json)) : undefined,
								xattrs: row.xattrs_json ? parseXattrsJson(String(row.xattrs_json)) : undefined
							}
						case 'set-dirent':
							return {
								kind: 'set-dirent',
								source: toStringOrNull(row.source) ?? undefined,
								dirIno: String(row.dir_ino),
								name: String(row.name),
								ino: String(row.entry_ino),
								type: toNumber(row.entry_type) as FileType
							}
						case 'unset-dirent':
							return {
								kind: 'unset-dirent',
								source: toStringOrNull(row.source) ?? undefined,
								dirIno: String(row.dir_ino),
								name: String(row.name),
								ino: toStringOrNull(row.entry_ino) ?? undefined
							}
						default:
							throw new Error(`Unknown fs update op: ${opKind}`)
					}
				}),
				options
			)

			return {
				ops,
				cursor: rows.length > 0 ? String(rows[rows.length - 1].seq) : headCursor
			}
		},

		// ── Path-sync seams ───────────────────────────────────────────────────
		//
		// SQLITE PATH-SYNC EPIC — remaining slices (one commit each; reference impl in
		// storage.mem.ts + storage.shared.ts + sync-replica.ts, specs in
		// packages/fs/sync-test-harness.ts `pathSyncConformanceCases`):
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
		//   5. [TODO(path-sync)] atomicMove subtree journaling: ordered delete(old subtree,
		//      child-first) + put(new subtree, parent-first), enumerated via a CTE.
		//      => rename conformance GREEN (5/5).
		//
		// caps.subscribe: the change feed fires after each mutation's txn commits.
		subscribe(listener: (change: StorageChange) => void): () => void {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
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
				const [row] = await db.query<{ head: unknown }>(
					'SELECT COALESCE(MAX(seq), 0) AS head FROM fs_path_journal'
				)
				return toNumber(row?.head ?? 0)
			}
		},
		pathApply: {
			async localChange(path: string): Promise<PathChange | null> {
				// Current local durable state at `path`, for the engine's LWW compare: a
				// linked path -> its put at the live path_version; else a tombstone -> its
				// delete; else null. `source` is excluded from the digest, so any id works.
				await ensureBootstrapped()
				const ino = await resolveIno(db, path)
				if (ino !== null) {
					const row = await getInode(db, ino)
					if (row) {
						const cur = await readPathVersion(db, path)
						return buildPutChange(
							path,
							metaFromRow(row),
							await listAllXattrs(db, ino),
							cur.version,
							localActorId
						)
					}
				}
				const cur = await readPathVersion(db, path)
				return cur.tombstone > 0 ? buildDeleteChange(path, cur.tombstone, localActorId) : null
			},
			async applyJournaled(changes: PathChange[], opts: { localSource?: string }): Promise<void> {
				// Remote-authored apply in ONE txn: install tree metadata + contentHash
				// REFERENCE, journal the change VERBATIM (its version + origin source) plus
				// localSource, and fast-forward path_version (never lower it). NEVER writes
				// blob bytes — those are materialised out-of-band by applyPathChanges. emit()
				// after commit so a volume over sqlite invalidates its cache on the pull.
				await ensureBootstrapped()
				const pendingEmits: StorageChange[] = []
				const orphanedR2Keys: string[] = []
				await db.transaction(async (tx) => {
					for (const change of changes) {
						const p = change.path
						const changeVersion = Number(change.version)
						if (change.kind === 'put') {
							const { parentPath, name } = splitPath(p)
							const parentIno = await ensureDirPath(tx, parentPath)
							const existing = await getDirent(tx, parentIno, name)
							const ino = existing ? String(existing.ino) : randomId()
							const type = change.meta.type
							await upsertInodeFromSync(tx, ino, change)
							await setDirent(tx, parentIno, name, ino, type)
							pendingEmits.push({ ino, kind: 'meta', source: opts.localSource })
							pendingEmits.push({
								ino,
								kind: 'dirent',
								dirIno: parentIno,
								name,
								source: opts.localSource
							})
							if (type === FileType.Regular)
								pendingEmits.push({ ino, kind: 'content', source: opts.localSource })
						} else {
							const ino = await resolveIno(tx, p)
							const { parentPath, name } = splitPath(p)
							const parentIno = await resolveIno(tx, parentPath)
							if (parentIno !== null)
								await tx.run('DELETE FROM fs_dirents WHERE dir_ino = ? AND name = ?', [
									parentIno,
									name
								])
							if (ino !== null) await deleteInodeInTx(tx, ino, orphanedR2Keys)
							if (ino !== null && parentIno !== null)
								pendingEmits.push({
									ino,
									kind: 'dirent',
									dirIno: parentIno,
									name,
									source: opts.localSource
								})
							if (ino !== null) pendingEmits.push({ ino, kind: 'meta', source: opts.localSource })
						}
						const cur = await readPathVersion(tx, p)
						const tombstone =
							change.kind === 'delete' ? Math.max(cur.tombstone, changeVersion) : cur.tombstone
						await setPathVersion(tx, p, Math.max(cur.version, changeVersion), tombstone)
						await appendJournalRow(tx, change, opts.localSource)
					}
				})
				if (blobStore?.delete) for (const key of orphanedR2Keys) await blobStore.delete(key)
				for (const change of pendingEmits) emit(change)
			}
		}
	}

	// ── Storage implementation ─────────────────────────────────────────

	return {
		rootIno: ROOT_INO,
		caps,

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
					await appendOps(
						tx,
						withSource([{ kind: 'upsert-inode', ino, meta: partial } as FsOp], options)
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
				await appendOps(
					tx,
					withSource([{ kind: 'upsert-inode', ino, meta: partial } as FsOp], options)
				)
				changed = true
				const path = await pathOf(tx, ino)
				if (path !== null) await journalPut(tx, path, ino, options)
			})
			if (changed) emit({ ino, kind: 'meta', source: options?.source })
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
			if (blobStore?.delete) {
				for (const key of orphanedR2Keys) {
					await blobStore.delete(key)
				}
			}
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
				await appendOps(
					tx,
					withSource(
						[
							{
								kind: 'set-dirent',
								dirIno,
								name,
								ino: entry.ino,
								type: entry.type
							} as FsOp
						],
						options
					)
				)
				const dirPath = await pathOf(tx, dirIno)
				if (dirPath !== null) await journalPut(tx, joinPath(dirPath, name), entry.ino, options)
			})
			emit({ ino: entry.ino, kind: 'dirent', dirIno, name, source: options?.source })
		},

		async deleteDirent(dirIno: Ino, name: string, options?: MutationOptions) {
			await ensureBootstrapped()
			let removedIno: Ino | null = null
			await db.transaction(async (tx) => {
				const existing = await getDirent(tx, dirIno, name)
				if (!existing) return
				removedIno = String(existing.ino)
				await tx.run('DELETE FROM fs_dirents WHERE dir_ino = ? AND name = ?', [dirIno, name])
				await appendOps(
					tx,
					withSource(
						[
							{
								kind: 'unset-dirent',
								dirIno,
								name,
								ino: String(existing.ino)
							} as FsOp
						],
						options
					)
				)
				const dirPath = await pathOf(tx, dirIno)
				if (dirPath !== null) await journalDelete(tx, joinPath(dirPath, name), options)
			})
			if (removedIno !== null)
				emit({ ino: removedIno, kind: 'dirent', dirIno, name, source: options?.source })
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
}
