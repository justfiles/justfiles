import { zValidator } from '@hono/zod-validator'
import { volume } from '@justfiles/fs'
import type { Storage } from '@justfiles/fs/storage'
import { journaledChangeSource, localSyncReplica, PAGE } from '@justfiles/fs/sync-replica'
import { PathChange } from '@justfiles/fs/sync-wire'
import type { FileType } from '@justfiles/fs/types'
import { Hono } from 'hono'
import { z } from 'zod'
import type { GenerationState } from './reset'

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
// Push fencing: a mutating request carries the client's known volume lineage
// here; a present-but-stale value is rejected.
const GENERATION_HEADER = 'x-fs-generation'
// Identity fence: a mutating request also carries the client's known volume
// IDENTITY here. `generation` alone can't tell two fresh volumes apart (both seed
// to 1), so a push aimed at a different volume at the same generation is rejected
// on a `lineageId` mismatch — preventing cross-volume contamination.
const LINEAGE_HEADER = 'x-fs-lineage'
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// ── Path-sync (/fs) transport contract ──────────────────────────────────────
// Wire schema is imported from @justfiles/fs/sync-wire (PathChange); the page
// shapes below reuse it schema-first. `protocolVersion` = wire contract;
// `schemaVersion` = /.state/sync shape. Both are 1 for this design.
const PROTOCOL_VERSION = 1
const SCHEMA_VERSION = 1

// `generation` = the server volume's lineage epoch. Optional: absent unless the
// host injects a lineage source, so a server that has not opted in reads as "no
// lineage signal" and the client stays on the legacy path. Surfaced on the
// handshake AND echoed on every pull/scan page so a mid-cycle reset is caught
// without a second round-trip. `resetId` is the advisory "a reset/republish is in
// progress" flag (crash-resume + UI), not a lock.
const Handshake = z.object({
	rootIno: z.string(),
	protocolVersion: z.number().int(),
	schemaVersion: z.number().int(),
	generation: z.number().int().optional(),
	resetId: z.string().optional(),
	// The volume's stable, unique lineage identity (see reset.ts). Orthogonal to
	// `generation` (the CAS/fence epoch): a client whose stored `lineageId` differs
	// from the observed one is talking to a genuinely different volume and
	// re-bootstraps. Optional — a host that injects no lineage source omits it.
	lineageId: z.string().optional(),
	// Does this server's backend have a hash-addressed content store (`caps.content`)?
	// A client create can only publish its bytes BEFORE claiming the name if it does,
	// because `PUT /blob/:hash` has nowhere to put a blob no inode references yet on a
	// backend without one. Optional: absent (an older server) reads as false, which
	// selects the claim-then-fill path that works everywhere.
	contentStore: z.boolean().optional()
})
// Deltas are one monotonic stream, so the page token IS the resume cursor.
const DeltaPage = z.object({
	changes: z.array(PathChange),
	to: z.string(), // SyncCursor to persist AND next-page token (same seq)
	done: z.boolean(), // false => more pages remain
	generation: z.number().int().optional()
})
// Snapshot: pagination position and sync high-water are DISTINCT.
const ScanPage = z.object({
	changes: z.array(PathChange),
	next: z.string().optional(), // opaque next-page token; absent when done
	syncCursor: z.string(), // delta high-water frozen at scan start; resume here
	done: z.boolean(),
	generation: z.number().int().optional()
})
const PathChangesBody = z.object({ changes: z.array(PathChange) })
const DeltaQuery = z.object({
	cursor: z.string().default(''),
	excludeOrigin: z.string().optional(),
	limit: z.coerce.number().int().positive().optional()
})
const SnapshotQuery = z.object({
	page: z.string().optional(),
	limit: z.coerce.number().int().positive().optional()
})
const ContentHash = z.string().regex(/^[0-9a-f]{64}$/)
const HashParam = z.object({ hash: ContentHash })
const MissingBlobsBody = z.object({ hashes: z.array(ContentHash).max(PAGE) })

// The lineage-mutation request (POST /fs/reset). `adopt-mine` / `wipe` CAS on
// `fromGeneration` (truncate + bump); `complete` is advisory — the initiator's
// republish drained, so clear the in-progress flag. The client's copy of this
// shape lives in @justfiles/fs (LineagePeer.ResetRequest, minus `wipe`, which is
// app-level factory reset); this is the server's validated one.
export const ResetBody = z.discriminatedUnion('mode', [
	z.object({
		mode: z.literal('adopt-mine'),
		fromGeneration: z.number().int(),
		operationId: z.string().min(1),
		resetId: z.string(),
		// The volume identity the client believes it is republishing onto. The reset
		// capability validates it atomically with the generation CAS (see reset.ts), so a
		// stale endpoint swap can't truncate a different volume at the same generation.
		lineageId: z.string().optional()
	}),
	z.object({
		mode: z.literal('wipe'),
		fromGeneration: z.number().int(),
		operationId: z.string().min(1),
		lineageId: z.string().optional()
	}),
	z.object({ mode: z.literal('complete'), resetId: z.string() })
])
export type ResetBody = z.infer<typeof ResetBody>
export type DestructiveResetBody = Exclude<ResetBody, { mode: 'complete' }>

export type ResetResult =
	| { ok: true; generation: number; replayed?: true }
	| { ok: false; error: 'generation_stale' | 'lineage_stale'; generation: number }

async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer)
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}

// ── API ──────────────────────────────────────────────────────────────────────

export function createFsApi(
	backend: Storage,
	opts?: {
		// The server volume's lineage: the epoch `generation` plus the advisory
		// `resetId`. Injected by the host (e.g. the DO's SQLite generation row);
		// omitted here so callers that haven't opted in report no lineage and clients
		// stay on the legacy path. Surfaced on the handshake, echoed on every pull/scan
		// page, and enforced on every mutating write.
		lineage?: () => GenerationState | Promise<GenerationState>
		// The write side of that lineage, behind POST /reset: CAS on `fromGeneration`,
		// truncate, bump. Injected because it needs the host's raw transactional store
		// (and, for a DO, a cache rebuild) — the library only owns the HTTP envelope.
		// Omitted => /reset answers 501.
		reset?: (req: ResetBody) => Promise<ResetResult>
	}
) {
	const errorMessage = (error: unknown): string =>
		error instanceof Error ? error.message : String(error)
	const readLineage = async (): Promise<GenerationState | undefined> =>
		opts?.lineage ? await opts.lineage() : undefined
	const vol = volume(backend)
	// The server serves the path endpoints over its own local SyncReplica. Origin
	// is stamped per-request from SOURCE_HEADER (see POST /path/changes), so the
	// construction-time localActorId is only a fallback.
	const replica = localSyncReplica(backend, journaledChangeSource(backend), {
		lazyContent: false,
		localActorId: 'server'
	})
	const mutationOptions = (request: Request): { source?: string } => {
		const source = request.headers.get(SOURCE_HEADER) ?? undefined
		return source ? { source } : {}
	}

	return (
		new Hono()

			// ── Lineage mutation ───────────────────────────────────────────────────
			// Registered BEFORE the fence below, so it is exempt from it: a stale client
			// is exactly the one that needs to reset. It self-guards via the injected
			// capability's own CAS. Always in the chain (so the typed client carries it);
			// 501 when the host injects no reset capability.
			.post('/reset', zValidator('json', ResetBody), async (c) => {
				if (!opts?.reset) return c.json({ error: 'reset not supported' }, 501)
				const result = await opts.reset(c.req.valid('json'))
				return result.ok
					? c.json({ generation: result.generation })
					: c.json({ error: result.error, generation: result.generation }, 409)
			})

			// ── Push fencing (anti-clobber) ────────────────────────────────────────
			// A mutating /fs request may carry `x-fs-generation` = the client's known
			// lineage; a present-but-stale value is rejected with 409 so the client
			// resets instead of clobbering a fresh reset baseline. An absent header
			// (legacy client) is allowed. GET/HEAD are reads; /reset is registered above
			// this fence and self-guards via its CAS. There is no publishing lock — a
			// "take mine" republish rides ordinary sync at the new generation and passes
			// this same check, and other devices converge eventually.
			.use('*', async (c, next) => {
				if (opts?.lineage && MUTATING_METHODS.has(c.req.method)) {
					const header = c.req.header(GENERATION_HEADER)
					const lineageHeader = c.req.header(LINEAGE_HEADER)
					const lineage = await readLineage()
					if (header !== undefined && lineage && Number(header) !== lineage.generation)
						return c.json({ error: 'generation_stale', generation: lineage.generation }, 409)
					// Identity fence: reject a write whose lineage no longer matches this volume
					// (a different volume recreated at the SAME generation, which `x-fs-generation`
					// can't catch). A DISTINCT `lineage_stale` error, because a generation reconcile
					// would be a no-op here — the client must reconcile identity (re-handshake +
					// re-bootstrap) to recover. Only enforced when both sides carry a lineageId.
					if (
						lineageHeader !== undefined &&
						lineage?.lineageId !== undefined &&
						lineageHeader !== lineage.lineageId
					)
						return c.json(
							{
								error: 'lineage_stale',
								generation: lineage.generation,
								lineageId: lineage.lineageId
							},
							409
						)
				}
				return next()
			})

			// ── Root ─────────────────────────────────────────────────────────────
			.get('/', async (c) => {
				const lineage = await readLineage()
				return c.json(
					Handshake.parse({
						rootIno: backend.rootIno,
						protocolVersion: PROTOCOL_VERSION,
						schemaVersion: SCHEMA_VERSION,
						generation: lineage?.generation,
						resetId: lineage?.resetId,
						lineageId: lineage?.lineageId,
						contentStore: backend.caps?.content !== undefined
					})
				)
			})

			// Path sync: PULL (client reads the server's ChangeSource)
			.get('/path/changes', zValidator('query', DeltaQuery), async (c) => {
				const { cursor, excludeOrigin, limit } = c.req.valid('query')
				const { changes, to, done } = await replica.pathDeltas(cursor, { excludeOrigin, limit })
				const lineage = await readLineage()
				c.header('Cache-Control', 'no-store')
				return c.json(DeltaPage.parse({ changes, to, done, generation: lineage?.generation }))
			})

			.get('/path/snapshot', zValidator('query', SnapshotQuery), async (c) => {
				const { page, limit } = c.req.valid('query')
				const { changes, next, syncCursor, done } = await replica.pathScan(page, { limit })
				const lineage = await readLineage()
				return c.json(
					ScanPage.parse({ changes, next, syncCursor, done, generation: lineage?.generation })
				)
			})

			// Path sync: PUSH (client writes path-changes; server applies to its Storage)
			.put('/blob/:hash', zValidator('param', HashParam), async (c) => {
				const { hash } = c.req.valid('param')
				const data = new Uint8Array(await c.req.arrayBuffer())
				// The server MUST verify sha256(bytes) === hash before accepting a blob.
				if ((await sha256Hex(data)) !== hash) return c.json({ error: 'hash mismatch' }, 400)
				await replica.putBlobByHash(hash, data)
				return c.body(null, 204)
			})

			.post('/blobs/missing', zValidator('json', MissingBlobsBody), async (c) => {
				const { hashes } = c.req.valid('json')
				const missing: string[] = []
				for (const hash of hashes) {
					if (!(await replica.hasBlobByHash(hash))) missing.push(hash)
				}
				return c.json({ missing })
			})

			.post('/path/changes', zValidator('json', PathChangesBody), async (c) => {
				const { changes } = c.req.valid('json')
				// SERVER-AUTHORITATIVE origin: ignore any `source` in the body, stamp the
				// authenticated caller's client-id on every applied change.
				const callerId = c.req.header(SOURCE_HEADER) ?? undefined
				const stamped: PathChange[] = changes.map((ch) => ({ ...ch, source: callerId }))
				// The server rejects a `put` whose contentHash has no stored blob.
				for (const ch of stamped) {
					if (
						ch.kind === 'put' &&
						ch.contentHash &&
						!(await replica.hasBlobByHash(ch.contentHash))
					) {
						return c.json({ error: `missing blob ${ch.contentHash}` }, 409)
					}
				}
				await replica.applyPathChanges(stamped, (h) => replica.getBlobByHash(h), {
					source: 'remote'
				})
				return c.json({ ok: true })
			})

			// ── Path sync: CONTENT (hydration, both directions) ───────────────────
			// GET and HEAD share ONE handler: Hono auto-routes HEAD to GET handlers, so
			// a separate `.on('HEAD', …)` would run the GET body for HEAD too and 500 on
			// an absent blob (getBlobByHash throws) instead of reporting 404. Branch on
			// the method here; a missing blob is a 404, never a 500.
			.on(['GET', 'HEAD'], '/blob/:hash', zValidator('param', HashParam), async (c) => {
				const { hash } = c.req.valid('param')
				if (c.req.method === 'HEAD')
					return c.body(null, (await replica.hasBlobByHash(hash)) ? 200 : 404)
				if (!(await replica.hasBlobByHash(hash))) return c.body(null, 404)
				const data = await replica.getBlobByHash(hash)
				return new Response(data.buffer as ArrayBuffer, {
					headers: { 'Content-Type': 'application/octet-stream' }
				})
			})

			// ── Whole-tree scan (volume.scan fast-path) ────────────────────────────

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
					next: result.next
				})
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
							// No `content`: the server's own backend has a hash-addressed content
							// store, and the client already PUT the bytes under their hash before
							// this claim (`meta.contentHash` references them).
							ino = await backend.caps.atomicCreate(
								dirIno,
								name,
								meta,
								undefined,
								mutationOptions(c.req.raw)
							)
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
