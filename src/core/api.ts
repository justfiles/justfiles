import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { CaptureInputSchema, SearchInputSchema, type Store } from './store/types'

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

	app.get('/v1/memory/:id', zValidator('param', z.object({ id: z.string().min(1) })), async (c) => {
		const { id } = c.req.param()
		const memory = await store.get(id)
		return c.json(memory)
	})

	return app
}
