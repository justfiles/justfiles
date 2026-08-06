import { sandboxWorkerSource } from '@justfiles/app/sandbox'
import { Hono } from 'hono'
import { Script, ViteClient } from 'vite-ssr-components/hono'
import { decodeLabel } from './id'
import { type AppMetadata, findApp } from './catalog'

type Env = { Bindings: CloudflareBindings }

export const route = new Hono<Env & { Variables: { app: AppMetadata } }>()

/**
 * The app id for a request: the first host label decoded, when it sits directly
 * under the root domain, else null (apex, workers.dev, deeper hosts, and any
 * label that is not the canonical encoding of an id — `www` among them, since
 * every id has two segments and so every app label has a hyphen).
 */
export const appId = (req: Request, env: CloudflareBindings): string | null => {
	const host = new URL(req.url).hostname.toLowerCase()
	// `*.localhost` keeps `wrangler dev` working without extra config.
	const root = (host.endsWith('.localhost') ? 'localhost' : env.ROOT_DOMAIN).toLowerCase()
	if (!host.endsWith(`.${root}`)) return null
	return decodeLabel(host.slice(0, -root.length - 1))
}

route.use('*', async (c, next) => {
	const id = appId(c.req.raw, c.env)
	const app = id ? await findApp(id) : null
	if (!app) return c.notFound()
	c.set('app', app)
	await next()
})

const MIME: Record<string, string> = {
	js: 'text/javascript; charset=utf-8',
	json: 'application/json; charset=utf-8',
	css: 'text/css; charset=utf-8',
	png: 'image/png',
	svg: 'image/svg+xml'
}

const mime = (path: string) => MIME[path.split('.').pop() ?? ''] ?? 'application/octet-stream'

route.get('/', async (c) =>
	c.html(
		<html lang="en">
			<head>
				<title>{c.var.app.name}</title>
				{/* The GUI is the app's own code, served from the store rather than bundled
				    into the platform entry below — so the browser only discovers it once
				    that entry runs. Start the fetch at parse time instead. */}
				<link rel="modulepreload" href="/gui.js" />
				<style>{'html, body, #app { height: 100%; margin: 0 }'}</style>
				<ViteClient />
				<Script src="/src/client/main.ts" />
			</head>
			<body>
				{/* The mount point, carrying the app's identity: the server read the
				    manifest to route this request, so the page inherits it rather than
				    fetching `/manifest.json` again before it can boot. */}
				<div
					id="app"
					data-id={c.var.app.id}
					data-name={c.var.app.name}
					data-version={c.var.app.version}
				></div>
			</body>
		</html>
	)
)

// The reducer isolate. Platform code, byte-identical for every app: a module
// Worker that imports the app's own `app.js` from this same origin and speaks
// the kernel's host↔isolate protocol. Served rather than blob'd so it stays
// cacheable and inspectable.
route.get('/worker.js', (c) =>
	c.body(sandboxWorkerSource('/app.js', 'web'), 200, { 'content-type': MIME.js as string })
)

route.get('/*', async (c) => {
	const body = await c.var.app.asset(c.req.path)
	if (body === null) return c.notFound()
	return c.body(body, 200, { 'content-type': mime(c.req.path) })
})
