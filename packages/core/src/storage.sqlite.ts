import type { DbAdapter } from './db'
import type { StorageBackend, FsOp, InodeMeta } from 'ghost-fs/storage'
import { FileType } from 'ghost-fs/types'
import type { DirCursor, Ino } from 'ghost-fs/types'

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
}

type InodeRow = {
	ino: unknown
	type: unknown
	mode: unknown
	nlink: unknown
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

function metaFromRow(row: InodeRow): InodeMeta {
	return {
		type: toNumber(row.type) as FileType,
		size: toBigInt(row.size),
		mode: toNumber(row.mode),
		nlink: toNumber(row.nlink),
		mtimeNs: toBigInt(row.mtime_ns),
		ctimeNs: toBigInt(row.ctime_ns),
		contentHash: toStringOrNull(row.content_hash) ?? undefined,
		symlinkTarget: toStringOrNull(row.symlink_target) ?? undefined
	}
}

function serializeMeta(meta: InodeMeta): string {
	return JSON.stringify({
		type: meta.type,
		size: meta.size.toString(),
		mode: meta.mode,
		nlink: meta.nlink,
		mtimeNs: meta.mtimeNs.toString(),
		ctimeNs: meta.ctimeNs.toString(),
		contentHash: meta.contentHash ?? null,
		symlinkTarget: meta.symlinkTarget ?? null
	})
}

function parseMetaJson(raw: string): InodeMeta {
	const parsed = JSON.parse(raw) as {
		type: number
		size: string
		mode: number
		nlink: number
		mtimeNs: string
		ctimeNs: string
		contentHash?: string | null
		symlinkTarget?: string | null
	}
	return {
		type: parsed.type as FileType,
		size: BigInt(parsed.size),
		mode: parsed.mode,
		nlink: parsed.nlink,
		mtimeNs: BigInt(parsed.mtimeNs),
		ctimeNs: BigInt(parsed.ctimeNs),
		contentHash: parsed.contentHash ?? undefined,
		symlinkTarget: parsed.symlinkTarget ?? undefined
	}
}

function serializeXattrs(xattrs: Record<string, Uint8Array | null>): string {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(xattrs).map(([name, value]) => [name, value === null ? null : encodeBytes(value)])
		)
	)
}

function parseXattrsJson(raw: string): Record<string, Uint8Array | null> {
	const parsed = JSON.parse(raw) as Record<string, string | null>
	return Object.fromEntries(
		Object.entries(parsed).map(([name, value]) => [name, value === null ? null : decodeBytes(value)])
	)
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

export function storage(db: DbAdapter, options: StorageOptions = {}): StorageBackend {
	const blobStore = options.blobStore
	const namespace = options.namespace ?? 'default'
	const inlineTextLimit = options.inlineTextLimitBytes ?? INLINE_TEXT_LIMIT_BYTES

	let bootstrapPromise: Promise<void> | null = null

	async function ensureBootstrapped(): Promise<void> {
		if (bootstrapPromise) return bootstrapPromise
		bootstrapPromise = (async () => {
			const existing = await db.query<{ ino: unknown }>('SELECT ino FROM fs_inodes WHERE ino = ? LIMIT 1', [
				ROOT_INO
			])
			if (existing.length > 0) return

			const now = nowNs()
			await db.transaction(async (tx) => {
				await tx.run(
					`INSERT OR IGNORE INTO fs_inodes(
						ino, type, mode, nlink, size, mtime_ns, ctime_ns, content_hash, symlink_target, mime_type, storage_kind
					) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
					[
						ROOT_INO,
						FileType.Directory,
						0o755,
						1,
						0,
						now,
						now,
						STORAGE_NONE
					]
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

	async function ensureRegularFile(tx: DbAdapter, ino: Ino): Promise<InodeRow> {
		const row = await getInode(tx, ino)
		if (!row) throw new Error(`ENOENT: ${ino}`)
		if (toNumber(row.type) !== FileType.Regular) throw new Error(`EINVAL: ${ino} is not a regular file`)
		return row
	}

	async function insertFtsRow(tx: DbAdapter, contentHash: string, text: string | null): Promise<void> {
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
		const [row] = await tx.query<ContentRow>('SELECT * FROM fs_contents WHERE content_hash = ? LIMIT 1', [
			contentHash
		])
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
							tx_id, op_index, at_ns, op_kind, ino, meta_json, xattrs_json, content_changed
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
						[
							txId,
							i,
							atNs,
							op.kind,
							op.ino,
							op.meta ? serializeMeta(op.meta) : null,
							op.xattrs ? serializeXattrs(op.xattrs) : null,
							op.contentChanged ? 1 : 0
						]
					)
					break
				case 'set-dirent':
					await tx.run(
						`INSERT INTO fs_updates(
							tx_id, op_index, at_ns, op_kind, dir_ino, name, entry_ino, entry_type
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
						[txId, i, atNs, op.kind, op.dirIno, op.name, op.ino, op.type]
					)
					break
				case 'unset-dirent':
					await tx.run(
						`INSERT INTO fs_updates(
							tx_id, op_index, at_ns, op_kind, dir_ino, name, entry_ino
						) VALUES (?, ?, ?, ?, ?, ?, ?)`,
						[txId, i, atNs, op.kind, op.dirIno, op.name, op.ino ?? null]
					)
					break
			}
		}
	}

	async function freeIfUnlinked(
		tx: DbAdapter,
		ino: Ino,
		orphanedR2Keys: string[]
	): Promise<void> {
		const inode = await getInode(tx, ino)
		if (!inode) return
		if (ino === ROOT_INO) return

		if (toNumber(inode.type) === FileType.Directory) {
			const childRows = await tx.query<{ count: unknown }>(
				'SELECT COUNT(*) AS count FROM fs_dirents WHERE dir_ino = ?',
				[ino]
			)
			if (toNumber(childRows[0]?.count ?? 0) > 0) throw new Error(`ENOTEMPTY: ${ino}`)
		}

		const nextNlink = toNumber(inode.nlink) - 1
		if (nextNlink > 0) {
			await tx.run('UPDATE fs_inodes SET nlink = ? WHERE ino = ?', [nextNlink, ino])
			return
		}

		const oldHash = toStringOrNull(inode.content_hash)
		await tx.run('DELETE FROM fs_xattrs WHERE ino = ?', [ino])
		await tx.run('DELETE FROM fs_inodes WHERE ino = ?', [ino])
		await maybeDeleteOrphanedContent(tx, oldHash, orphanedR2Keys)
	}

	async function updateInodeContent(
		ino: Ino,
		data: Uint8Array
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
			await appendOps(tx, [
				{
					kind: 'upsert-inode',
					ino,
					meta: nextMeta,
					contentChanged: true
				}
			])
		})

		if (blobStore?.delete) {
			for (const key of orphanedR2Keys) {
				await blobStore.delete(key)
			}
		}
	}

	return {
		rootIno: ROOT_INO,

		async alloc(meta) {
			await ensureBootstrapped()
			const ino = randomId()
			const stamp = nowNs()
			const size = meta.type === FileType.Regular ? 0 : Number(meta.size)
			const nextMeta: InodeMeta = {
				...meta,
				size: BigInt(size),
				nlink: 0
			}

			await db.transaction(async (tx) => {
				await tx.run(
					`INSERT INTO fs_inodes(
						ino, type, mode, nlink, size, mtime_ns, ctime_ns, content_hash, symlink_target, mime_type, storage_kind
					) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
					[
						ino,
						meta.type,
						meta.mode,
						0,
						size,
						meta.mtimeNs ?? stamp,
						meta.ctimeNs ?? stamp,
						meta.symlinkTarget ?? null,
						STORAGE_NONE
					]
				)
				await appendOps(tx, [{ kind: 'upsert-inode', ino, meta: nextMeta }])
			})

			return ino
		},

		async create(dirIno, name, meta) {
			await ensureBootstrapped()
			const ino = randomId()
			const stamp = nowNs()
			const size = meta.type === FileType.Regular ? 0 : Number(meta.size)
			const nextMeta: InodeMeta = {
				...meta,
				size: BigInt(size),
				nlink: 1
			}

			await db.transaction(async (tx) => {
				await ensureDirectory(tx, dirIno)
				const existing = await getDirent(tx, dirIno, name)
				if (existing) throw new Error(`EEXIST: ${name}`)

				await tx.run(
					`INSERT INTO fs_inodes(
						ino, type, mode, nlink, size, mtime_ns, ctime_ns, content_hash, symlink_target, mime_type, storage_kind
					) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
					[
						ino,
						meta.type,
						meta.mode,
						1,
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
				await appendOps(tx, [
					{ kind: 'upsert-inode', ino, meta: nextMeta },
					{ kind: 'set-dirent', dirIno, name, ino, type: meta.type }
				])
			})

			return ino
		},

		async getMeta(ino) {
			await ensureBootstrapped()
			const row = await getInode(db, ino)
			return row ? metaFromRow(row) : null
		},

		async setMeta(ino, partial) {
			await ensureBootstrapped()
			await db.transaction(async (tx) => {
				const row = await getInode(tx, ino)
				if (!row) return
				const current = metaFromRow(row)
				const next: InodeMeta = {
					...current,
					...partial
				}
				await tx.run(
					`UPDATE fs_inodes
					 SET mode = ?, mtime_ns = ?, ctime_ns = ?, symlink_target = ?
					 WHERE ino = ?`,
					[next.mode, next.mtimeNs, next.ctimeNs, next.symlinkTarget ?? null, ino]
				)
				await appendOps(tx, [{ kind: 'upsert-inode', ino, meta: next }])
			})
		},

		async getXattr(ino, name) {
			await ensureBootstrapped()
			const rows = await db.query<{ value: unknown }>(
				'SELECT value FROM fs_xattrs WHERE ino = ? AND name = ? LIMIT 1',
				[ino, name]
			)
			if (rows.length === 0) return null
			return toUint8Array(rows[0].value)
		},

		async setXattr(ino, name, value) {
			await ensureBootstrapped()
			await db.transaction(async (tx) => {
				const inode = await getInode(tx, ino)
				if (!inode) throw new Error(`ENOENT: ${ino}`)
				await tx.run(
					`INSERT INTO fs_xattrs(ino, name, value) VALUES (?, ?, ?)
					 ON CONFLICT(ino, name) DO UPDATE SET value = excluded.value`,
					[ino, name, value]
				)
				await appendOps(tx, [
					{
						kind: 'upsert-inode',
						ino,
						xattrs: { [name]: value.slice() }
					}
				])
			})
		},

		async listXattr(ino) {
			await ensureBootstrapped()
			const rows = await db.query<{ name: unknown }>(
				'SELECT name FROM fs_xattrs WHERE ino = ? ORDER BY name',
				[ino]
			)
			return rows.map((row) => String(row.name))
		},

		async removeXattr(ino, name) {
			await ensureBootstrapped()
			await db.transaction(async (tx) => {
				await tx.run('DELETE FROM fs_xattrs WHERE ino = ? AND name = ?', [ino, name])
				await appendOps(tx, [
					{
						kind: 'upsert-inode',
						ino,
						xattrs: { [name]: null }
					}
				])
			})
		},

		async read(ino, offset, length) {
			await ensureBootstrapped()
			const full = await readFullContent(db, ino)
			const start = Number(offset)
			return full.slice(start, start + length)
		},

		async write(ino, offset, data) {
			await ensureBootstrapped()
			const full = await readFullContent(db, ino)
			const start = Number(offset)
			const next = new Uint8Array(Math.max(full.length, start + data.length))
			next.set(full)
			next.set(data, start)
			await updateInodeContent(ino, next)
			return data.length
		},

		async truncate(ino, size) {
			await ensureBootstrapped()
			const full = await readFullContent(db, ino)
			const next = new Uint8Array(Number(size))
			next.set(full.subarray(0, Number(size)))
			await updateInodeContent(ino, next)
		},

		async dirLookup(dirIno, name) {
			await ensureBootstrapped()
			const row = await getDirent(db, dirIno, name)
			return row
				? {
						ino: String(row.ino),
						type: toNumber(row.type) as FileType
					}
				: null
		},

		async dirList(dirIno, cursor: DirCursor) {
			await ensureBootstrapped()
			const rows = cursor === ''
				? await db.query<DirentRow>(
						`SELECT dir_ino, name, ino, type
						 FROM fs_dirents
						 WHERE dir_ino = ?
						 ORDER BY name
						 LIMIT ?`,
						[dirIno, DIR_PAGE_SIZE]
					)
				: await db.query<DirentRow>(
						`SELECT dir_ino, name, ino, type
						 FROM fs_dirents
						 WHERE dir_ino = ? AND name > ?
						 ORDER BY name
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
		},

		async dirAdd(dirIno, name, ino, type) {
			await ensureBootstrapped()
			let added = false
			await db.transaction(async (tx) => {
				await ensureDirectory(tx, dirIno)
				const target = await getInode(tx, ino)
				if (!target) throw new Error(`ENOENT: ${ino}`)
				const existing = await getDirent(tx, dirIno, name)
				if (existing) return

				await tx.run('INSERT INTO fs_dirents(dir_ino, name, ino, type) VALUES (?, ?, ?, ?)', [
					dirIno,
					name,
					ino,
					type
				])
				await tx.run('UPDATE fs_inodes SET nlink = nlink + 1 WHERE ino = ?', [ino])
				await appendOps(tx, [{ kind: 'set-dirent', dirIno, name, ino, type }])
				added = true
			})
			return added
		},

		async dirSet(dirIno, name, ino, type) {
			await ensureBootstrapped()
			let displaced: { ino: Ino; type: FileType } | null = null
			const orphanedR2Keys: string[] = []

			await db.transaction(async (tx) => {
				await ensureDirectory(tx, dirIno)
				const target = await getInode(tx, ino)
				if (!target) throw new Error(`ENOENT: ${ino}`)
				const existing = await getDirent(tx, dirIno, name)
				displaced = existing
					? { ino: String(existing.ino), type: toNumber(existing.type) as FileType }
					: null

				if (existing && String(existing.ino) === ino && toNumber(existing.type) === type) return

				if (existing) {
					await tx.run('UPDATE fs_dirents SET ino = ?, type = ? WHERE dir_ino = ? AND name = ?', [
						ino,
						type,
						dirIno,
						name
					])
				} else {
					await tx.run('INSERT INTO fs_dirents(dir_ino, name, ino, type) VALUES (?, ?, ?, ?)', [
						dirIno,
						name,
						ino,
						type
					])
				}

				if (!existing || String(existing.ino) !== ino) {
					await tx.run('UPDATE fs_inodes SET nlink = nlink + 1 WHERE ino = ?', [ino])
				}

				if (existing && String(existing.ino) !== ino) {
					await freeIfUnlinked(tx, String(existing.ino), orphanedR2Keys)
				}

				await appendOps(tx, [{ kind: 'set-dirent', dirIno, name, ino, type }])
			})

			if (blobStore?.delete) {
				for (const key of orphanedR2Keys) {
					await blobStore.delete(key)
				}
			}

			return displaced
		},

		async dirUnset(dirIno, name) {
			await ensureBootstrapped()
			let removed: { ino: Ino; type: FileType } | null = null
			const orphanedR2Keys: string[] = []

			await db.transaction(async (tx) => {
				const entry = await getDirent(tx, dirIno, name)
				if (!entry) return

				removed = { ino: String(entry.ino), type: toNumber(entry.type) as FileType }
				await tx.run('DELETE FROM fs_dirents WHERE dir_ino = ? AND name = ?', [dirIno, name])
				await freeIfUnlinked(tx, String(entry.ino), orphanedR2Keys)
				await appendOps(tx, [{ kind: 'unset-dirent', dirIno, name, ino: String(entry.ino) }])
			})

			if (blobStore?.delete) {
				for (const key of orphanedR2Keys) {
					await blobStore.delete(key)
				}
			}

			return removed
		},

		async rename(oldDirIno, oldName, newDirIno, newName) {
			await ensureBootstrapped()
			let displaced: Ino | null = null
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
					await tx.run('DELETE FROM fs_dirents WHERE dir_ino = ? AND name = ?', [newDirIno, newName])
					await freeIfUnlinked(tx, String(destination.ino), orphanedR2Keys)
				}

				await tx.run('UPDATE fs_dirents SET dir_ino = ?, name = ? WHERE dir_ino = ? AND name = ?', [
					newDirIno,
					newName,
					oldDirIno,
					oldName
				])

				await appendOps(tx, [
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
				])
			})

			if (blobStore?.delete) {
				for (const key of orphanedR2Keys) {
					await blobStore.delete(key)
				}
			}

			return displaced
		},

		async scan(cursor) {
			await ensureBootstrapped()
			const rows = cursor === ''
				? await db.query<{
						path: unknown
						ino: unknown
						dir_ino: unknown
						name: unknown
						type: unknown
						mode: unknown
						nlink: unknown
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
							inode.nlink,
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
						nlink: unknown
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
							inode.nlink,
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

			return {
				entries: rows.map((row) => ({
					ino: String(row.ino),
					dirIno: String(row.dir_ino),
					name: String(row.name),
					meta: {
						type: toNumber(row.type) as FileType,
						size: toBigInt(row.size),
						mode: toNumber(row.mode),
						nlink: toNumber(row.nlink),
						mtimeNs: toBigInt(row.mtime_ns),
						ctimeNs: toBigInt(row.ctime_ns),
						contentHash: toStringOrNull(row.content_hash) ?? undefined,
						symlinkTarget: toStringOrNull(row.symlink_target) ?? undefined
					}
				})),
				next: rows.length === SCAN_PAGE_SIZE ? String(rows[rows.length - 1].path) : ''
			}
		},

		async putBlob(ino, data) {
			await updateInodeContent(ino, data)
		},

		async updates(cursor) {
			await ensureBootstrapped()
			const since = cursor === '' ? 0 : Number.parseInt(cursor, 10)
			const rows = await db.query<UpdateRow>(
				`SELECT
					seq,
					op_kind,
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
				[Number.isFinite(since) ? since : 0]
			)

			const ops: FsOp[] = rows.map((row) => {
				const opKind = String(row.op_kind)
				switch (opKind) {
					case 'upsert-inode':
						return {
							kind: 'upsert-inode',
							ino: String(row.ino),
							meta: row.meta_json ? parseMetaJson(String(row.meta_json)) : undefined,
							xattrs: row.xattrs_json ? parseXattrsJson(String(row.xattrs_json)) : undefined,
							contentChanged: toNumber(row.content_changed) === 1
						}
					case 'set-dirent':
						return {
							kind: 'set-dirent',
							dirIno: String(row.dir_ino),
							name: String(row.name),
							ino: String(row.entry_ino),
							type: toNumber(row.entry_type) as FileType
						}
					case 'unset-dirent':
						return {
							kind: 'unset-dirent',
							dirIno: String(row.dir_ino),
							name: String(row.name),
							ino: toStringOrNull(row.entry_ino) ?? undefined
						}
					default:
						throw new Error(`Unknown fs update op: ${opKind}`)
				}
			})

			return {
				ops,
				cursor: rows.length > 0 ? String(rows[rows.length - 1].seq) : cursor
			}
		}
	}
}
