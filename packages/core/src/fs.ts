import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { FsCursorExpiredError, type StorageBackend, type FsOp } from 'ghost-fs'

type InodeMeta = NonNullable<Awaited<ReturnType<StorageBackend['getMeta']>>>
type InodeMetaPatch = Partial<InodeMeta>

// ── Wire-format helpers ──────────────────────────────────────────────────────
// JSON cannot represent bigint natively; transmit them as decimal strings.

const BigIntStr = z.string().regex(/^\d+$/).transform(BigInt)
const FileTypeNum = z.number().int().min(0).max(2)

const WireMetaSchema = z.object({
	type: FileTypeNum,
	size: BigIntStr,
	mode: z.number().int(),
	mtimeNs: BigIntStr,
	ctimeNs: BigIntStr,
	contentHash: z.string().optional(),
	symlinkTarget: z.string().optional(),
})

const WireMetaPartialSchema = z.object({
	type: FileTypeNum.optional(),
	size: BigIntStr.optional(),
	mode: z.number().int().optional(),
	nlink: z.number().int().optional(),
	mtimeNs: BigIntStr.optional(),
	ctimeNs: BigIntStr.optional(),
	contentHash: z.string().optional(),
	symlinkTarget: z.string().optional(),
})

function encodeMeta(meta: InodeMetaPatch) {
	const encoded: Record<string, unknown> = { ...meta }
	if (meta.size !== undefined) encoded.size = meta.size.toString()
	if (meta.mtimeNs !== undefined) encoded.mtimeNs = meta.mtimeNs.toString()
	if (meta.ctimeNs !== undefined) encoded.ctimeNs = meta.ctimeNs.toString()
	return encoded
}

function encodeBytes(arr: Uint8Array): string {
	let str = ''
	for (const b of arr) str += String.fromCharCode(b)
	return btoa(str)
}

function encodeOp(op: FsOp) {
	if (op.kind !== 'upsert-inode') return op
	return {
		...op,
		meta: op.meta ? encodeMeta(op.meta) : undefined,
		xattrs: op.xattrs
			? Object.fromEntries(
				Object.entries(op.xattrs).map(([k, v]) => [k, v ? encodeBytes(v) : null])
			  )
			: undefined,
	}
}

function inferContentType(filename: string): string {
	const lower = filename.toLowerCase()
	if (lower.endsWith('.png')) return 'image/png'
	if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
	if (lower.endsWith('.gif')) return 'image/gif'
	if (lower.endsWith('.webp')) return 'image/webp'
	if (lower.endsWith('.svg')) return 'image/svg+xml'
	if (lower.endsWith('.pdf')) return 'application/pdf'
	if (lower.endsWith('.json')) return 'application/json; charset=utf-8'
	if (lower.endsWith('.txt') || lower.endsWith('.md')) return 'text/plain; charset=utf-8'
	return 'application/octet-stream'
}

// ── Param / query schemas ────────────────────────────────────────────────────

const InoParam = z.object({ ino: z.string() })
const InoFilenameParam = z.object({ ino: z.string(), filename: z.string() })
const DirInoParam = z.object({ dirIno: z.string() })
const DirInoNameParam = z.object({ dirIno: z.string(), name: z.string() })
const CursorQuery = z.object({ cursor: z.string().default('') })
const SOURCE_HEADER = 'x-fs-source'

// ── API ──────────────────────────────────────────────────────────────────────

export function createFsApi(backend: StorageBackend) {
	const errorMessage = (error: unknown): string =>
		error instanceof Error ? error.message : String(error)
	const mutationOptions = (request: Request): { source?: string } => {
		const source = request.headers.get(SOURCE_HEADER) ?? undefined
		return source ? { source } : {}
	}

	return new Hono()

		// ── Root ─────────────────────────────────────────────────────────────
		// Entry point: tells the client which inode is the root.
		.get('/', (c) => c.json({ rootIno: backend.rootIno }))

		// ── Sync primitives ───────────────────────────────────────────────────
		// These are the two most important endpoints for sync.
		// /updates drives incremental sync; /scan drives full reconciliation.

		.get('/updates', zValidator('query', CursorQuery), async (c) => {
			if (!backend.updates) return c.json({ error: 'not supported' }, 501)
			const { cursor } = c.req.valid('query')
			const source = c.req.header(SOURCE_HEADER) ?? undefined
			let result: Awaited<ReturnType<NonNullable<StorageBackend['updates']>>>
			try {
				result = await backend.updates(
					cursor,
					source ? { source, sourceMode: 'exclude' } : undefined
				)
			} catch (error) {
				if (error instanceof FsCursorExpiredError) {
					return c.json({ error: error.message, code: 'cursor_expired' }, 409)
				}
				throw error
			}
			c.header('Cache-Control', 'no-store')
			return c.json({ ops: result.ops.map(encodeOp), cursor: result.cursor })
		})

		.get('/scan', zValidator('query', CursorQuery), async (c) => {
			if (!backend.scan) return c.json({ error: 'not supported' }, 501)
			const { cursor } = c.req.valid('query')
			const result = await backend.scan(cursor)
			return c.json({
				entries: result.entries.map((e) => ({ ...e, meta: encodeMeta(e.meta) })),
				next: result.next,
				cursor: result.cursor,
			})
		})

		// ── Inode metadata ────────────────────────────────────────────────────

		// Atomic alloc + dirAdd — never expose bare alloc() over the network.
		.post('/inodes', zValidator('json', z.object({
			dirIno: z.string(),
			name: z.string(),
			meta: WireMetaSchema,
		})), async (c) => {
			const { dirIno, name, meta } = c.req.valid('json')
			let ino: string
			try {
				if (backend.create) {
					ino = await backend.create(dirIno, name, meta, mutationOptions(c.req.raw))
				} else {
					ino = await backend.alloc(meta, mutationOptions(c.req.raw))
					const added = await backend.dirAdd(dirIno, name, ino, meta.type, mutationOptions(c.req.raw))
					if (!added) return c.json({ error: `EEXIST: ${name}` }, 409)
				}
			} catch (error) {
				const message = errorMessage(error)
				if (message.startsWith('EEXIST:')) return c.json({ error: message }, 409)
				if (message.startsWith('ENOENT:') || message.startsWith('ENOTDIR:')) {
					return c.json({ error: message }, 404)
				}
				throw error
			}
			return c.json({ ino }, 201)
		})

		.get('/inodes/:ino', zValidator('param', InoParam), async (c) => {
			const { ino } = c.req.valid('param')
			const meta = await backend.getMeta(ino)
			if (!meta) return c.json({ error: 'not found' }, 404)
			return c.json(encodeMeta(meta))
		})

		.patch('/inodes/:ino', zValidator('param', InoParam), zValidator('json', WireMetaPartialSchema), async (c) => {
			const { ino } = c.req.valid('param')
			const partial = c.req.valid('json')
			await backend.setMeta(ino, partial, mutationOptions(c.req.raw))
			return c.json({ ok: true })
		})

		// ── Blob content ──────────────────────────────────────────────────────
		// Binary transfer. Kept separate from metadata so the JSON endpoints
		// stay clean and content-type negotiation is unambiguous.

		.get('/inodes/:ino/blob', zValidator('param', InoParam), async (c) => {
			const { ino } = c.req.valid('param')
			const meta = await backend.getMeta(ino)
			if (!meta) return c.json({ error: 'not found' }, 404)
			const data = await backend.read(ino, 0n, Number(meta.size))
			return new Response(data.buffer as ArrayBuffer, {
				headers: { 'Content-Type': 'application/octet-stream' },
			})
		})

		.get('/inodes/:ino/content/:filename', zValidator('param', InoFilenameParam), async (c) => {
			const { ino, filename } = c.req.valid('param')
			const meta = await backend.getMeta(ino)
			if (!meta) return c.json({ error: 'not found' }, 404)

			const etag = meta.contentHash ? `"${meta.contentHash}"` : null
			if (etag && c.req.header('if-none-match') === etag) {
				return new Response(null, {
					status: 304,
					headers: {
						etag,
						'cache-control': 'private, max-age=31536000, immutable',
					},
				})
			}

			const data = await backend.read(ino, 0n, Number(meta.size))
			const headers = new Headers({
				'content-type': inferContentType(filename),
				'cache-control': etag
					? 'private, max-age=31536000, immutable'
					: 'private, no-cache',
				'x-content-type-options': 'nosniff',
			})
			if (etag) headers.set('etag', etag)
			return new Response(data.buffer as ArrayBuffer, { headers })
		})

		.put('/inodes/:ino/blob', zValidator('param', InoParam), async (c) => {
			const { ino } = c.req.valid('param')
			const data = new Uint8Array(await c.req.arrayBuffer())
			if (backend.putBlob) {
				await backend.putBlob(ino, data, mutationOptions(c.req.raw))
			} else {
				await backend.truncate(ino, 0n, mutationOptions(c.req.raw))
				if (data.length > 0) await backend.write(ino, 0n, data, mutationOptions(c.req.raw))
			}
			return c.json({ ok: true })
		})

		// ── Directory entries ─────────────────────────────────────────────────

		.get('/inodes/:dirIno/entries', zValidator('param', DirInoParam), zValidator('query', CursorQuery), async (c) => {
			const { dirIno } = c.req.valid('param')
			const { cursor } = c.req.valid('query')
			const result = await backend.dirList(dirIno, cursor)
			return c.json(result)
		})

		.get('/inodes/:dirIno/entries/:name', zValidator('param', DirInoNameParam), async (c) => {
			const { dirIno, name } = c.req.valid('param')
			const entry = await backend.dirLookup(dirIno, name)
			if (!entry) return c.json({ error: 'not found' }, 404)
			return c.json(entry)
		})

		// dirSet: unconditional overwrite, used in rename's destination step.
		// Returns the displaced entry so the caller can invalidate its cache.
		.put('/inodes/:dirIno/entries/:name', zValidator('param', DirInoNameParam), zValidator('json', z.object({
			ino: z.string(),
			type: FileTypeNum,
		})), async (c) => {
			const { dirIno, name } = c.req.valid('param')
			const { ino, type } = c.req.valid('json')
			const displaced = await backend.dirSet(dirIno, name, ino, type, mutationOptions(c.req.raw))
			return c.json({ displaced })
		})

		// dirUnset: remove entry and decrement nlink (backend frees inode if 0).
		.delete('/inodes/:dirIno/entries/:name', zValidator('param', DirInoNameParam), async (c) => {
			const { dirIno, name } = c.req.valid('param')
			const removed = await backend.dirUnset(dirIno, name, mutationOptions(c.req.raw))
			if (!removed) return c.json({ error: 'not found' }, 404)
			return c.json({ removed })
		})

		// ── Rename ────────────────────────────────────────────────────────────
		// Returns the displaced ino so the caller can evict it from its cache.
		// Falls back to dirSet + dirUnset if backend.rename is absent.
		.post('/rename', zValidator('json', z.object({
			oldDirIno: z.string(),
			oldName: z.string(),
			newDirIno: z.string(),
			newName: z.string(),
		})), async (c) => {
			const { oldDirIno, oldName, newDirIno, newName } = c.req.valid('json')
			let displaced: string | null = null
			try {
				if (backend.rename) {
					displaced = await backend.rename(oldDirIno, oldName, newDirIno, newName, mutationOptions(c.req.raw))
				} else {
					const source = await backend.dirLookup(oldDirIno, oldName)
					if (!source) return c.json({ error: `ENOENT: ${oldName}` }, 404)
					const d = await backend.dirSet(newDirIno, newName, source.ino, source.type, mutationOptions(c.req.raw))
					await backend.dirUnset(oldDirIno, oldName, mutationOptions(c.req.raw))
					displaced = d?.ino ?? null
				}
			} catch (error) {
				const message = errorMessage(error)
				if (message.startsWith('ENOENT:') || message.startsWith('ENOTDIR:')) {
					return c.json({ error: message }, 404)
				}
				if (message.startsWith('ENOTEMPTY:')) return c.json({ error: message }, 409)
				throw error
			}
			return c.json({ displaced })
		})
}
