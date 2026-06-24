import { Hono } from 'hono'
import design from '@justfiles/design/design.css' with { type: 'text' }
import mac from '@justfiles/design/mac.css' with { type: 'text' }

// Static imports so `bun build --compile` inlines the bytes into the executable;
// the map keys are the allowlist for the `/design/:name` route.
const styles: Record<string, string> = { 'design.css': design, 'mac.css': mac }

const app = new Hono()
app.get('/design/:name', (c) => {
	const body = styles[c.req.param('name')]
	if (!body) return c.notFound()
	return new Response(body, { headers: { 'content-type': 'text/css; charset=utf-8' } })
})

export default app
