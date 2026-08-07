import type { AppManifest } from '@justfiles/app'
import { sandboxWorkerSource } from '@justfiles/app/sandbox'
import { Hono } from 'hono'
import { Script, ViteClient } from 'vite-ssr-components/hono'
import { findApp } from './catalog'
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
 * `/v/{version}/…` is resolved by string construction and reaches the store
 * without a lookup, which is what makes ONE `info.json` read per PAGE load
 * enough — the shell below emits version-pinned URLs, so nothing after the
 * document has to ask what the live version is.
 *
 * It is also what keeps the app's own state out of reach. `info.json` sits in
 * the same prefix as the bytes we serve, and the fixed `version` and `files`
 * segments are what a request path cannot climb out of: an R2 key is an opaque
 * string, so a `..` in one is a character, never a parent directory.
 */
const versioned = (id: string, version: string) => `apps/${id}/${version}`

route.get('/v/:version/*', async (c) => {
	const id = appId(c.req.raw, c.env)
	const version = c.req.param('version')
	if (!id) return c.notFound()
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
