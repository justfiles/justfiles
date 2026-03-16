import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { CaptureInputSchema, ListInputSchema, SearchInputSchema, UpdateInputSchema, type Store } from './store/types'

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

	app.post('/v1/capture', zValidator('json', CaptureInputSchema), async (c) => {
		const input = c.req.valid('json')
		const id = await store.capture(input)
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

	app.get('/v1/recent', async (c) => {
		const raw = c.req.query('n')
		const n = Math.min(raw ? Math.max(1, parseInt(raw, 10) || 5) : 5, 20)
		const results = await store.recent(n)
		return c.json({ results })
	})

	return app
}
