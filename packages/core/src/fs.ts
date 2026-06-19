import { zValidator } from '@hono/zod-validator'
import { volume } from '@justfiles/fs'
import { FsCursorExpiredError, type FsOp, type Storage } from '@justfiles/fs/storage'
import type { FileType } from '@justfiles/fs/types'
import { Hono } from 'hono'
import { z } from 'zod'

type InodeMeta = NonNullable<Awaited<ReturnType<Storage['getMeta']>>>
type InodeMetaPatch = Partial<InodeMeta>

// ── Wire-format helpers ──────────────────────────────────────────────────────
// JSON cannot represent bigint natively; transmit them as decimal strings.

const BigIntStr = z.string().regex(/^\d+$/).transform(BigInt)
const FileTypeNum = z
	.number()
	.int()
	.min(0)
	.max(2)
	.transform((n) => n as FileType)

const WireMetaSchema = z.object({
	type: FileTypeNum,
	size: BigIntStr,
	mode: z.number().int(),
	mtimeNs: BigIntStr,
	ctimeNs: BigIntStr,
	contentHash: z.string().optional(),
	symlinkTarget: z.string().optional()
})

const WireMetaPartialSchema = z.object({
	type: FileTypeNum.optional(),
	size: BigIntStr.optional(),
	mode: z.number().int().optional(),
	mtimeNs: BigIntStr.optional(),
	ctimeNs: BigIntStr.optional(),
	contentHash: z.string().optional(),
	symlinkTarget: z.string().optional()
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

function decodeBytes(b64: string): Uint8Array {
	const binary = atob(b64)
	const arr = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i)
	return arr
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
			: undefined
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

// Batch apply payload — the sync push fast-path. Mirrors FsOp; upsert carries
// optional inlined blob content (base64) so one request replaces the per-op
// setMeta + putBlob + xattr round-trips.
const BatchOpsSchema = z.object({
	ops: z.array(
		z.discriminatedUnion('kind', [
			z.object({
				kind: z.literal('upsert-inode'),
				ino: z.string(),
				meta: WireMetaPartialSchema.optional(),
				xattrs: z.record(z.string(), z.string().nullable()).optional(),
				data: z.string().optional()
			}),
			z.object({
				kind: z.literal('set-dirent'),
				dirIno: z.string(),
				name: z.string(),
				ino: z.string(),
				type: FileTypeNum
			}),
			z.object({
				kind: z.literal('unset-dirent'),
				dirIno: z.string(),
				name: z.string(),
				ino: z.string().optional()
			})
		])
	)
})

// ── API ──────────────────────────────────────────────────────────────────────

export function createFsApi(backend: Storage) {
	const errorMessage = (error: unknown): string =>
		error instanceof Error ? error.message : String(error)
	const vol = volume(backend)
	const mutationOptions = (request: Request): { source?: string } => {
		const source = request.headers.get(SOURCE_HEADER) ?? undefined
		return source ? { source } : {}
	}

	return (
		new Hono()

			// ── Root ─────────────────────────────────────────────────────────────
			.get('/', (c) => c.json({ rootIno: backend.rootIno }))

			// ── Sync primitives ───────────────────────────────────────────────────

			.get('/updates', zValidator('query', CursorQuery), async (c) => {
				if (!backend.caps?.deltaUpdates) return c.json({ error: 'not supported' }, 501)
				const { cursor } = c.req.valid('query')
				const source = c.req.header(SOURCE_HEADER) ?? undefined
				let result: Awaited<ReturnType<NonNullable<typeof backend.caps.deltaUpdates>>>
				try {
					result = await backend.caps.deltaUpdates(
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
				if (!backend.caps?.fullScan) return c.json({ error: 'not supported' }, 501)
				const { cursor } = c.req.valid('query')
				const result = await backend.caps.fullScan(cursor)
				return c.json({
					entries: result.entries.map((e) => ({
						...e,
						meta: encodeMeta(e.meta),
						xattrs: e.xattrs
							? Object.fromEntries(Object.entries(e.xattrs).map(([k, v]) => [k, encodeBytes(v)]))
							: undefined
					})),
					next: result.next,
					syncCursor: result.syncCursor
				})
			})

			// Batch apply — one request applies many ops (sync push).
			.post('/ops', zValidator('json', BatchOpsSchema), async (c) => {
				const { ops } = c.req.valid('json')
				const opts = mutationOptions(c.req.raw)
				for (const op of ops) {
					if (op.kind === 'upsert-inode') {
						if (op.meta) await backend.setMeta(op.ino, op.meta, opts)
						if (op.data !== undefined) await backend.putBlob(op.ino, decodeBytes(op.data), opts)
						for (const [name, value] of Object.entries(op.xattrs ?? {})) {
							if (name.startsWith('trusted.sync.')) continue
							if (value === null) await backend.caps?.removeXattr?.(op.ino, name, opts)
							else await backend.caps?.setXattr?.(op.ino, name, decodeBytes(value), opts)
						}
					} else if (op.kind === 'set-dirent') {
						// Self-heal: a diverged replica can re-push a set-dirent whose target
						// inode the server no longer has. Applying it throws ENOENT, which
						// 500s the whole batch — and since the push never advances its cursor,
						// every future sync re-sends the same op and stays wedged. Skip-and-log
						// the dangling entry instead so sync recovers on its own.
						if (!(await backend.getMeta(op.ino))) {
							console.warn(
								`fs/ops: skipped dangling set-dirent ${op.dirIno}/${op.name} → missing inode ${op.ino}`
							)
							continue
						}
						const existing = await backend.getDirent(op.dirIno, op.name)
						await backend.putDirent(op.dirIno, op.name, { ino: op.ino, type: op.type }, opts)
						if (existing && existing.ino !== op.ino) await backend.deleteInode(existing.ino)
					} else {
						const existing = await backend.getDirent(op.dirIno, op.name)
						if (existing) {
							await backend.deleteDirent(op.dirIno, op.name, opts)
							await backend.deleteInode(existing.ino)
						}
					}
				}
				return c.json({ ok: true })
			})

			// ── Inode metadata ────────────────────────────────────────────────────

			.post(
				'/inodes',
				zValidator(
					'json',
					z.object({
						dirIno: z.string(),
						name: z.string(),
						meta: WireMetaSchema
					})
				),
				async (c) => {
					const { dirIno, name, meta } = c.req.valid('json')
					let ino: string
					try {
						if (backend.caps?.atomicCreate) {
							ino = await backend.caps.atomicCreate(dirIno, name, meta, mutationOptions(c.req.raw))
						} else {
							ino = crypto.randomUUID()
							await backend.setMeta(ino, meta, mutationOptions(c.req.raw))
							await backend.putDirent(
								dirIno,
								name,
								{ ino, type: meta.type },
								mutationOptions(c.req.raw)
							)
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
				}
			)

			.get('/inodes/:ino', zValidator('param', InoParam), async (c) => {
				const { ino } = c.req.valid('param')
				const meta = await backend.getMeta(ino)
				if (!meta) return c.json({ error: 'not found' }, 404)
				return c.json(encodeMeta(meta))
			})

			.patch(
				'/inodes/:ino',
				zValidator('param', InoParam),
				zValidator('json', WireMetaPartialSchema),
				async (c) => {
					const { ino } = c.req.valid('param')
					const partial = c.req.valid('json')
					await backend.setMeta(ino, partial, mutationOptions(c.req.raw))
					return c.json({ ok: true })
				}
			)

			// ── Blob content ──────────────────────────────────────────────────────

			.get('/inodes/:ino/blob', zValidator('param', InoParam), async (c) => {
				const { ino } = c.req.valid('param')
				const meta = await backend.getMeta(ino)
				if (!meta) return c.json({ error: 'not found' }, 404)
				const data = await backend.getBlob(ino)
				return new Response(data.buffer as ArrayBuffer, {
					headers: { 'Content-Type': 'application/octet-stream' }
				})
			})

			.get('/file/*', async (c) => {
				const requestPath = new URL(c.req.url).pathname
				const routePrefix = requestPath.startsWith('/fs/file') ? '/fs/file' : '/file'
				const rawPath =
					requestPath === routePrefix
						? '/'
						: requestPath.startsWith(`${routePrefix}/`)
							? requestPath.slice(routePrefix.length)
							: '/'
				const path = rawPath ? decodeURIComponent(rawPath) : '/'

				try {
					const data = await vol.readFile(path)
					return new Response(data.buffer as ArrayBuffer, {
						headers: {
							'content-type': inferContentType(path)
						}
					})
				} catch (error) {
					const message = errorMessage(error)
					if (message.startsWith('ENOENT:')) return c.json({ error: message }, 404)
					if (message.startsWith('EISDIR:')) return c.json({ error: message }, 400)
					throw error
				}
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
							'cache-control': 'private, max-age=31536000, immutable'
						}
					})
				}

				const data = await backend.getBlob(ino)
				const headers = new Headers({
					'content-type': inferContentType(filename),
					'cache-control': etag ? 'private, max-age=31536000, immutable' : 'private, no-cache',
					'x-content-type-options': 'nosniff'
				})
				if (etag) headers.set('etag', etag)
				return new Response(data.buffer as ArrayBuffer, { headers })
			})

			.put('/inodes/:ino/blob', zValidator('param', InoParam), async (c) => {
				const { ino } = c.req.valid('param')
				const data = new Uint8Array(await c.req.arrayBuffer())
				await backend.putBlob(ino, data, mutationOptions(c.req.raw))
				return c.json({ ok: true })
			})

			// ── Extended attributes ───────────────────────────────────────────────

			.get('/inodes/:ino/xattrs', zValidator('param', InoParam), async (c) => {
				const { ino } = c.req.valid('param')
				const names = (await backend.caps?.listXattrs?.(ino)) ?? []
				return c.json({ names })
			})

			.get(
				'/inodes/:ino/xattrs/:name',
				zValidator('param', InoParam.extend({ name: z.string() })),
				async (c) => {
					const { ino, name } = c.req.valid('param')
					const value = await backend.caps?.getXattr?.(ino, name)
					if (value === null || value === undefined) return c.json({ error: 'not found' }, 404)
					return c.json({ value: encodeBytes(value) })
				}
			)

			.put(
				'/inodes/:ino/xattrs/:name',
				zValidator('param', InoParam.extend({ name: z.string() })),
				zValidator('json', z.object({ value: z.string() })),
				async (c) => {
					const { ino, name } = c.req.valid('param')
					const { value } = c.req.valid('json')
					const decoded = decodeBytes(value)
					await backend.caps?.setXattr?.(ino, name, decoded, mutationOptions(c.req.raw))
					return c.json({ ok: true })
				}
			)

			.delete(
				'/inodes/:ino/xattrs/:name',
				zValidator('param', InoParam.extend({ name: z.string() })),
				async (c) => {
					const { ino, name } = c.req.valid('param')
					await backend.caps?.removeXattr?.(ino, name, mutationOptions(c.req.raw))
					return c.json({ ok: true })
				}
			)

			// ── Directory entries ─────────────────────────────────────────────────

			.get(
				'/inodes/:dirIno/entries',
				zValidator('param', DirInoParam),
				zValidator('query', CursorQuery),
				async (c) => {
					const { dirIno } = c.req.valid('param')
					const { cursor } = c.req.valid('query')
					const result = await backend.listDirents(dirIno, cursor)
					return c.json(result)
				}
			)

			.get('/inodes/:dirIno/entries/:name', zValidator('param', DirInoNameParam), async (c) => {
				const { dirIno, name } = c.req.valid('param')
				const entry = await backend.getDirent(dirIno, name)
				if (!entry) return c.json({ error: 'not found' }, 404)
				return c.json(entry)
			})

			// putDirent: insert or replace. Returns displaced entry info for cache invalidation.
			.put(
				'/inodes/:dirIno/entries/:name',
				zValidator('param', DirInoNameParam),
				zValidator(
					'json',
					z.object({
						ino: z.string(),
						type: FileTypeNum
					})
				),
				async (c) => {
					const { dirIno, name } = c.req.valid('param')
					const { ino, type } = c.req.valid('json')
					const existing = await backend.getDirent(dirIno, name)
					await backend.putDirent(dirIno, name, { ino, type }, mutationOptions(c.req.raw))
					const displaced = existing && existing.ino !== ino ? existing : null
					if (displaced) {
						await backend.deleteInode(displaced.ino)
					}
					return c.json({ displaced })
				}
			)

			// deleteDirent + deleteInode: remove entry and free the inode.
			.delete('/inodes/:dirIno/entries/:name', zValidator('param', DirInoNameParam), async (c) => {
				const { dirIno, name } = c.req.valid('param')
				const entry = await backend.getDirent(dirIno, name)
				if (!entry) return c.json({ error: 'not found' }, 404)
				await backend.deleteDirent(dirIno, name, mutationOptions(c.req.raw))
				await backend.deleteInode(entry.ino)
				return c.json({ removed: entry })
			})

			// ── Rename ────────────────────────────────────────────────────────────
			.post(
				'/rename',
				zValidator(
					'json',
					z.object({
						oldDirIno: z.string(),
						oldName: z.string(),
						newDirIno: z.string(),
						newName: z.string()
					})
				),
				async (c) => {
					const { oldDirIno, oldName, newDirIno, newName } = c.req.valid('json')
					let displaced: string | null = null
					try {
						if (backend.caps?.atomicMove) {
							displaced = await backend.caps.atomicMove(
								oldDirIno,
								oldName,
								newDirIno,
								newName,
								mutationOptions(c.req.raw)
							)
						} else {
							const source = await backend.getDirent(oldDirIno, oldName)
							if (!source) return c.json({ error: `ENOENT: ${oldName}` }, 404)
							const dest = await backend.getDirent(newDirIno, newName)
							await backend.putDirent(
								newDirIno,
								newName,
								{ ino: source.ino, type: source.type },
								mutationOptions(c.req.raw)
							)
							await backend.deleteDirent(oldDirIno, oldName, mutationOptions(c.req.raw))
							if (dest && dest.ino !== source.ino) {
								await backend.deleteInode(dest.ino)
								displaced = dest.ino
							}
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
				}
			)
	)
}
