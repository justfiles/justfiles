import { Hono } from 'hono'
import { html } from 'hono/html'

type Env = {
	Bindings: CloudflareBindings
	Variables: { sub: string | null }
}

/** First label of `host` when it sits directly under `root`, else null (apex/unknown/deep host). */
const subdomain = (host: string, root: string): string | null => {
	const h = host.toLowerCase()
	const suffix = `.${root.toLowerCase()}`
	if (!h.endsWith(suffix)) return null
	const label = h.slice(0, -suffix.length)
	return /^[a-z0-9][a-z0-9-]*$/.test(label) ? label : null
}

const app = new Hono<Env>()

app.use('*', async (c, next) => {
	const { hostname } = new URL(c.req.url)
	// `*.localhost` keeps `wrangler dev` working without extra config.
	const root = hostname.endsWith('.localhost') ? 'localhost' : c.env.ROOT_DOMAIN
	c.set('sub', subdomain(hostname, root))
	await next()
})

app.get('/', (c) => {
	const sub = c.get('sub')
	if (!sub) return c.html(html`<h1>runner</h1>`)
	return c.html(html`<h1>app: ${sub}</h1>`)
})

export default app
