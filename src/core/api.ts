import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { WriteInputSchema, LinkInputSchema, ListInputSchema, SearchInputSchema, UpdateInputSchema, type Store } from './store'

const ChangesQuerySchema = z.object({ since: z.string().default('') })

/**
 * Creates the Hono app.
 *
 * The DB is initialized lazily via getDb(), which reads DB_PATH from env.
 *
 * For Cloudflare Workers, create a separate CF entry point that sets up
 * a D1-backed db instance and registers it before calling createApp().
 */
export function createApi(store: Store) {
	const app = new Hono()

	// REST API
	app.get('/v1/status', async (c) => {
		return c.json({})
	})

	app.post('/v1/write', zValidator('json', WriteInputSchema), async (c) => {
		const input = c.req.valid('json')
		const id = await store.write(input)
		return c.json({ id })
	})

	app.post('/v1/search', zValidator('json', SearchInputSchema), async (c) => {
		const input = c.req.valid('json')
		const results = await store.search(input)
		return c.json({ results })
	})

	app.post('/v1/update', zValidator('json', UpdateInputSchema), async (c) => {
		const input = c.req.valid('json')
		await store.update(input)
		return c.json({ ok: true })
	})

	app.post('/v1/list', zValidator('json', ListInputSchema), async (c) => {
		const input = c.req.valid('json')
		const results = await store.list(input)
		return c.json({ results })
	})

	app.get('/v1/memory/:id', zValidator('param', z.object({ id: z.string().min(1) })), async (c) => {
		const { id } = c.req.param()
		const memory = await store.get(id)
		if (!memory) return c.json({ error: 'Memory not found' }, 404)
		return c.json(memory)
	})

	app.post('/v1/memory/:id/archive', zValidator('param', z.object({ id: z.string().min(1) })), async (c) => {
		const { id } = c.req.param()
		try {
			await store.archive(id)
			return c.json({ archived: true, id })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (msg.includes('not found')) return c.json({ error: msg }, 404)
			throw err
		}
	})

	app.post('/v1/memory/:id/revive', zValidator('param', z.object({ id: z.string().min(1) })), async (c) => {
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

	app.delete('/v1/memory/:id', zValidator('param', z.object({ id: z.string().min(1) })), async (c) => {
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

	app.get('/v1/recent', async (c) => {
		const raw = c.req.query('n')
		const n = Math.min(raw ? Math.max(1, parseInt(raw, 10) || 5) : 5, 20)
		const results = await store.recent(n)
		return c.json({ results })
	})

	app.get('/v1/changes', zValidator('query', ChangesQuerySchema), async (c) => {
		const { since } = c.req.valid('query')
		const result = await store.changes(since)
		return c.json(result)
	})

	app.get('/v1/draft', async (c) => {
		const existing = await store.findByPath('*draft*')
		if (existing) return c.json(existing)
		const id = await store.write({ path: '*draft*', text: '' })
		return c.json({ id, raw_text: '' })
	})

	app.post('/v1/links', zValidator('json', LinkInputSchema), async (c) => {
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

	return app
}
