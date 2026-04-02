import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { type StorageBackend, type FsOp } from 'ghost-fs'

type InodeMeta = NonNullable<Awaited<ReturnType<StorageBackend['getMeta']>>>

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
	mode: z.number().int().optional(),
	mtimeNs: BigIntStr.optional(),
	ctimeNs: BigIntStr.optional(),
	symlinkTarget: z.string().optional(),
})

function encodeMeta(meta: InodeMeta) {
	return {
		...meta,
		size: meta.size.toString(),
		mtimeNs: meta.mtimeNs.toString(),
		ctimeNs: meta.ctimeNs.toString(),
	}
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

// ── Param / query schemas ────────────────────────────────────────────────────

const InoParam = z.object({ ino: z.string() })
const DirInoParam = z.object({ dirIno: z.string() })
const DirInoNameParam = z.object({ dirIno: z.string(), name: z.string() })
const CursorQuery = z.object({ cursor: z.string().default('') })

// ── API ──────────────────────────────────────────────────────────────────────

export function createFsApi(backend: StorageBackend) {
	const errorMessage = (error: unknown): string =>
		error instanceof Error ? error.message : String(error)

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
			const result = await backend.updates(cursor)
			return c.json({ ops: result.ops.map(encodeOp), cursor: result.cursor })
		})

		.get('/scan', zValidator('query', CursorQuery), async (c) => {
			if (!backend.scan) return c.json({ error: 'not supported' }, 501)
			const { cursor } = c.req.valid('query')
			const result = await backend.scan(cursor)
			return c.json({
				entries: result.entries.map((e) => ({ ...e, meta: encodeMeta(e.meta) })),
				next: result.next,
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
					ino = await backend.create(dirIno, name, meta)
				} else {
					ino = await backend.alloc(meta)
					const added = await backend.dirAdd(dirIno, name, ino, meta.type)
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
			await backend.setMeta(ino, partial)
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

		.put('/inodes/:ino/blob', zValidator('param', InoParam), async (c) => {
			const { ino } = c.req.valid('param')
			const data = new Uint8Array(await c.req.arrayBuffer())
			if (backend.putBlob) {
				await backend.putBlob(ino, data)
			} else {
				await backend.truncate(ino, 0n)
				if (data.length > 0) await backend.write(ino, 0n, data)
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
			const displaced = await backend.dirSet(dirIno, name, ino, type)
			return c.json({ displaced })
		})

		// dirUnset: remove entry and decrement nlink (backend frees inode if 0).
		.delete('/inodes/:dirIno/entries/:name', zValidator('param', DirInoNameParam), async (c) => {
			const { dirIno, name } = c.req.valid('param')
			const removed = await backend.dirUnset(dirIno, name)
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
					displaced = await backend.rename(oldDirIno, oldName, newDirIno, newName)
				} else {
					const source = await backend.dirLookup(oldDirIno, oldName)
					if (!source) return c.json({ error: `ENOENT: ${oldName}` }, 404)
					const d = await backend.dirSet(newDirIno, newName, source.ino, source.type)
					await backend.dirUnset(oldDirIno, oldName)
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
