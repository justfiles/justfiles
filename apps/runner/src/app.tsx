import type { AppManifest } from '@justfiles/app'
import { sandboxWorkerSource } from '@justfiles/app/sandbox'
import { Hono } from 'hono'
import { Script, ViteClient } from 'vite-ssr-components/hono'
import { findApp, servable } from './catalog'
import swSource from './client/sw.js?raw'
import { decodeLabel } from './id'

type Env = { Bindings: CloudflareBindings }

export const route = new Hono<Env>()

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

const MIME: Record<string, string> = {
	js: 'text/javascript; charset=utf-8',
	json: 'application/json; charset=utf-8',
	css: 'text/css; charset=utf-8',
	png: 'image/png',
	svg: 'image/svg+xml'
}

const mime = (path: string) => MIME[path.split('.').pop() ?? ''] ?? 'application/octet-stream'

/**
 * Everything under `/v/{version}/` is frozen once written, so it can be cached
 * for a year and never revalidated.
 */
const IMMUTABLE = 'public, max-age=31536000, immutable'

/**
 * `/v/{version}/…` is resolved by string construction: the shell below emits
 * version-pinned URLs, so nothing after the document has to ask what the live
 * version is. The one thing it does ask is whether the named version is a
 * release we finished importing — see `servable` — because the path is
 * caller-supplied and everything under it is cached for a year.
 *
 * It is also what keeps the app's own state out of reach. `info.json` sits in
 * the same prefix as the bytes we serve, and the fixed `version` and `files`
 * segments are what a request path cannot climb out of: an R2 key is an opaque
 * string, so a `..` in one is a character, never a parent directory.
 */
const versioned = (id: string, version: string) => `apps/${id}/${version}`

/**
 * Everything under `/v/` is readable by any origin.
 *
 * A desktop installs a hosted app by fetching this release's `spec.json` and
 * reducer from another origin, and mounts its GUI and assets the same way on
 * every cache miss — so without this the whole store is reachable only from the
 * app's own page, which is the one context that does not need it.
 *
 * `*` rather than an allowlist because there is nothing here to scope: these
 * bytes are already public, the origin carries no credentials to leak into a
 * cross-origin read, and every file is pinned by digest in the record that
 * names it, so a reader that gets the wrong bytes rejects them itself. A
 * literal `*` also needs no `Vary`, which is what keeps this one CDN entry per
 * URL rather than one per requesting origin.
 *
 * Applied after the handler so it covers the 404s too: to a cross-origin
 * caller, a response without this header is a network error rather than a
 * status it can read and report.
 */
route.use('/v/:version/*', async (c, next) => {
	await next()
	c.res.headers.set('access-control-allow-origin', '*')
})

route.get('/v/:version/*', async (c) => {
	const id = appId(c.req.raw, c.env)
	const version = c.req.param('version')
	if (!id || !(await servable(c.env, id, version))) return c.notFound()
	const path = c.req.path.slice(`/v/${version}/`.length)

	// The reducer isolate: platform code, byte-identical for every app, but it
	// imports one release's `app.js` and so is pinned like the bytes it loads.
	if (path === 'worker.js')
		return c.body(sandboxWorkerSource(`/v/${version}/app.js`, 'web'), 200, {
			'content-type': MIME.js as string,
			'cache-control': IMMUTABLE
		})

	// The installable record: what we stored, plus the one field we deliberately
	// do not store. `baseUrl` comes from the host this request arrived on rather
	// than from the id, so a custom domain pins itself with nothing to guess —
	// and an app id never enters stored release data. See kb/registry.md.
	if (path === 'spec.json') {
		const spec = await c.env.STORE.get(`${versioned(id, version)}/spec.json`)
		if (!spec) return c.notFound()
		const manifest = await spec.json<AppManifest>()
		return c.json({ ...manifest, baseUrl: `${new URL(c.req.url).origin}/v/${version}/` }, 200, {
			'cache-control': IMMUTABLE
		})
	}

	// Streamed straight through, so a 10 MB bundle never becomes a 10 MB string
	// in a 128 MB isolate.
	const body = (await c.env.STORE.get(`${versioned(id, version)}/files/${path}`))?.body
	if (!body) return c.notFound()
	return c.body(body, 200, { 'content-type': mime(path), 'cache-control': IMMUTABLE })
})

// Never cached hard: a stale service worker is the one thing that cannot be
// fixed from the server side. Browsers also bypass the HTTP cache when checking
// for an update, so this only has to not fight them.
route.get('/sw.js', (c) =>
	c.body(swSource, 200, { 'content-type': MIME.js as string, 'cache-control': 'no-cache' })
)

/**
 * The web app manifest, per app — this origin hosts exactly one, so it gets its
 * own name and icon rather than the runner's.
 *
 * It is what makes the app installable, and installing is not cosmetic: a
 * home-screen web app runs outside Safari's seven-day cap on script-writable
 * storage, which is the only documented exemption from it. Without this, an app
 * a Safari user has not opened in a week loses its whole origin — the volume
 * and their documents with it, since eviction is all-or-nothing per origin.
 *
 * Named `.webmanifest`, not `manifest.json`: that name already means the app's
 * own authored manifest, which is served from `/v/{version}/`.
 */
route.get('/manifest.webmanifest', async (c) => {
	const id = appId(c.req.raw, c.env)
	const app = id && (await findApp(c.env, id))
	if (!app) return c.notFound()

	const base = `/v/${app.version}/`
	const icons = app.icon
		? [
				{
					src: `${base}${app.icon}`,
					sizes: await iconSize(c.env, `apps/${app.id}/${app.version}/files/${app.icon}`),
					type: mime(app.icon),
					purpose: 'any'
				}
			]
		: []

	return c.body(
		JSON.stringify({
			name: app.name,
			short_name: app.name,
			start_url: '/',
			scope: '/',
			display: 'standalone',
			icons
		}),
		200,
		{ 'content-type': 'application/manifest+json' }
	)
})

/**
 * A PNG states its dimensions in the IHDR chunk at a fixed offset, so 24 bytes
 * of range read answer it. Worth the read rather than a guess: installability
 * depends on the declared size being real — Chrome wants at least 144×144 — and
 * a manifest that lies about it is worse than one with no icon.
 */
async function iconSize(env: CloudflareBindings, key: string): Promise<string> {
	const head = await env.STORE.get(key, { range: { offset: 0, length: 24 } })
	if (!head) return 'any'

	const bytes = new Uint8Array(await head.arrayBuffer())
	// Signature, then the IHDR length and tag, then width and height.
	if (bytes.length < 24 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return 'any'
	const view = new DataView(bytes.buffer)
	return `${view.getUint32(16)}x${view.getUint32(20)}`
}

/** The one route that asks what the live version is. */
route.get('/', async (c) => {
	const id = appId(c.req.raw, c.env)
	const app = id ? await findApp(c.env, id) : null
	if (!app) return c.notFound()

	const base = `/v/${app.version}/`
	return c.html(
		<html lang="en">
			<head>
				<title>{app.name}</title>
				{/* The GUI is the app's own code, served from the store rather than bundled
				    into the platform entry below — so the browser only discovers it once
				    that entry runs. Start the fetch at parse time instead. */}
				<link rel="modulepreload" href={`${base}gui.js`} />
				<link rel="manifest" href="/manifest.webmanifest" />
				<style>{'html, body, #app { height: 100%; margin: 0 }'}</style>
				<ViteClient />
				<Script src="/src/client/main.ts" />
			</head>
			<body>
				{/* The mount point, carrying the app's identity AND the version-pinned
				    origin its bytes come from: resolving the live version is this
				    request's job, so the page inherits the answer rather than asking
				    again — and every URL the client builds stays pinned to the release
				    this document was rendered for. */}
				<div
					id="app"
					data-id={app.id}
					data-name={app.name}
					data-version={app.version}
					data-base={base}
				></div>
			</body>
		</html>
	)
})
