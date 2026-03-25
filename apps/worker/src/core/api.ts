import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import {
	WriteInputSchema,
	LinkInputSchema,
	ListInputSchema,
	SearchInputSchema,
	UpdateInputSchema,
	StoreError,
	type Store
} from './store'

const ChangesQuerySchema = z.object({ since: z.string().default('') })
const RecentQuerySchema = z.object({ n: z.string().optional() })
const IdParamSchema = z.object({ id: z.string().min(1) })

/**
 * Creates the Hono app.
 *
 * The DB is initialized lazily via getDb(), which reads DB_PATH from env.
 *
 * For Cloudflare Workers, create a separate CF entry point that sets up
 * a D1-backed db instance and registers it before calling createApp().
 */
export function createApi(store: Store) {
	// REST API — use method chaining so Hono can infer route types for the RPC client
	return new Hono()
		.get('/v1/status', async (c) => {
			return c.json({})
		})
		.post('/v1/write', zValidator('json', WriteInputSchema), async (c) => {
			try {
				const input = c.req.valid('json')
				const id = await store.write(input)
				return c.json({ id })
			} catch (err) {
				if (err instanceof StoreError && err.code === 'CONFLICT') {
					return c.json({ error: err.message, ...err.data }, 409)
				}
				throw err
			}
		})
		.post('/v1/search', zValidator('json', SearchInputSchema), async (c) => {
			const input = c.req.valid('json')
			const results = await store.search(input)
			return c.json({ results })
		})
		.post('/v1/update', zValidator('json', UpdateInputSchema), async (c) => {
			const input = c.req.valid('json')
			await store.update(input)
			return c.json({ ok: true })
		})
		.post('/v1/list', zValidator('json', ListInputSchema), async (c) => {
			const input = c.req.valid('json')
			const response = await store.list(input)
			return c.json(response)
		})
		.get('/v1/memory/:id', zValidator('param', IdParamSchema), async (c) => {
			const { id } = c.req.param()
			console.log(`fetching ${id}`)
			const memory = await store.get(id)
			if (!memory) return c.json({ error: 'Memory not found' }, 404)
			return c.json(memory)
		})
		.post('/v1/memory/:id/archive', zValidator('param', IdParamSchema), async (c) => {
			const { id } = c.req.param()
			const { not_found } = await store.archive(id)
			if (not_found.length > 0) return c.json({ error: `Memory not found: ${id}` }, 404)
			return c.json({ archived: true, id })
		})
		.post('/v1/memory/:id/revive', zValidator('param', IdParamSchema), async (c) => {
			const { id } = c.req.param()
			try {
				await store.revive(id)
				return c.json({ revived: true, id })
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				if (msg.includes('not found')) return c.json({ error: msg }, 404)
				throw err
			}
		})
		.delete('/v1/memory/:id', zValidator('param', IdParamSchema), async (c) => {
			const { id } = c.req.param()
			try {
				await store.purge(id)
				return c.json({ deleted: true, id })
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				if (msg.includes('not found')) return c.json({ error: msg }, 404)
				throw err
			}
		})
		.get('/v1/recent', zValidator('query', RecentQuerySchema), async (c) => {
			const { n: raw } = c.req.valid('query')
			const n = Math.min(raw ? Math.max(1, parseInt(raw, 10) || 5) : 5, 20)
			const results = await store.recent(n)
			return c.json({ results })
		})
		.get('/v1/changes', zValidator('query', ChangesQuerySchema), async (c) => {
			const { since } = c.req.valid('query')
			const result = await store.changes(since)
			return c.json(result)
		})
		.get('/v1/draft', async (c) => {
			const existing = await store.findByPath('*draft*')
			if (existing) return c.json(existing)
			const id = await store.write({ path: '*draft*', content: '' })
			return c.json({ id, raw_text: '' })
		})
		.post('/v1/links', zValidator('json', LinkInputSchema), async (c) => {
			const input = c.req.valid('json')
			try {
				await store.link(input)
				return c.json({ ok: true })
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				if (msg.includes('not found')) return c.json({ error: msg }, 404)
				throw err
			}
		})
}

export type ApiType = ReturnType<typeof createApi>
