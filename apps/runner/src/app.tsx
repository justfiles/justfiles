import { sandboxWorkerSource } from '@justfiles/app/sandbox'
import macCss from '@justfiles/design/mac.css?inline'
import { Hono } from 'hono'
import { raw } from 'hono/html'
import type { MiddlewareHandler } from 'hono/types'
import { Script, ViteClient } from 'vite-ssr-components/hono'
import { findApp, servable } from './catalog'
import { readRecord } from './catalog/refresh-app'
import swSource from './client/sw.js?raw'
import { frameDocument, guestCsp } from './gui-frame'
import { decodeLabel } from './id'

type Env = { Bindings: CloudflareBindings }

export const route = new Hono<Env>()

/** Decode the first host label only when it is a direct app subdomain. */
export const appId = (req: Request, env: CloudflareBindings): string | null => {
	const host = new URL(req.url).hostname.toLowerCase()
	// `*.localhost` keeps `wrangler dev` working without extra config.
	const root = (host.endsWith('.localhost') ? 'localhost' : env.ROOT_DOMAIN).toLowerCase()
	if (!host.endsWith(`.${root}`)) return null
	return decodeLabel(host.slice(0, -root.length - 1))
}

const MIME: Record<string, string> = {
	html: 'text/html; charset=utf-8',
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
 * The one mutable document, cached only briefly: a publish becomes visible in
 * about a minute, and the immutable URL it points at pays nothing.
 */
const POINTER = 'public, max-age=60'

const PAGE_CSP = (local: boolean) =>
	[
		"default-src 'none'",
		"script-src 'self'",
		"style-src 'unsafe-inline'",
		"img-src 'self' data:",
		"font-src 'self' data:",
		"manifest-src 'self'",
		`connect-src 'self'${local ? ' ws:' : ''}`,
		"worker-src 'self'",
		"frame-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'self'"
	].join('; ')

const WORKER_CSP = "default-src 'none'; script-src 'self'; connect-src 'self'"
const GUI_FRAME = frameDocument(macCss)

const SHELL_STYLE = `
:root { color-scheme: light dark }
html, body { height: 100%; margin: 0 }
body { display: flex; flex-direction: column; overflow: hidden }
#runner-shelf { --bg: #f7f7f5; --text: #1b1a18; --dim: #6f6c66; --rule: #e8e6e0; --mark: #b06a2c;
	align-items: center; background: var(--bg); border-bottom: 1px solid var(--rule);
	box-sizing: border-box; color: var(--text); display: flex; flex: 0 0 32px;
	font: 12px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; gap: 9px; height: 32px;
	padding: 0 12px; transition: margin-top .3s cubic-bezier(.32,.72,0,1), opacity .2s ease; z-index: 2147483647 }
#runner-shelf .runner-shelf-icon { align-items: center; background: var(--rule); border-radius: 5px;
	display: flex; flex: none; font-size: 10px; height: 17px; justify-content: center; overflow: hidden; width: 17px }
#runner-shelf .runner-shelf-icon img { display: block; height: 100%; object-fit: cover; width: 100% }
#runner-shelf .runner-shelf-name { font-size: 12.5px; font-weight: 550 }
#runner-shelf .runner-shelf-name, #runner-shelf .runner-shelf-host { overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
#runner-shelf .runner-shelf-dot { background: var(--dim); border-radius: 50%; flex: none; height: 3px; opacity: .5; width: 3px }
#runner-shelf .runner-shelf-host { color: var(--dim); font-size: 11.5px }
#runner-shelf .runner-shelf-home { align-items: center; border-radius: 999px; color: var(--mark); display: flex;
	flex: none; font-size: 11.5px; font-weight: 550; gap: 5px; margin-left: auto; padding: 5px 9px; text-decoration: none }
#runner-shelf .runner-shelf-home:hover { background: color-mix(in srgb, var(--mark) 15%, transparent) }
#runner-shelf .runner-shelf-home:focus-visible { outline: 2px solid var(--mark); outline-offset: -2px }
#runner-shelf .runner-shelf-dots { display: grid; gap: 2px; grid-template-columns: 1fr 1fr }
#runner-shelf .runner-shelf-dots i { background: currentColor; border-radius: 1px; height: 4px; width: 4px }
body.runner-shelf-hidden #runner-shelf { margin-top: -32px; opacity: 0; pointer-events: none }
#app { flex: 1; min-height: 0; overflow: hidden; position: relative; width: 100% }
#app-frame { border: 0; display: block; height: 100%; width: 100% }
#app-error { align-items: center; background: Canvas; color: CanvasText; display: flex; inset: 0;
	justify-content: center; padding: 24px; position: absolute; text-align: center }
#app-error[hidden] { display: none }
@media (prefers-color-scheme: dark) { #runner-shelf {
	--bg: #16171a; --text: #eae8e3; --dim: #8e8b85; --rule: #26282d; --mark: #dda05a } }
@media (prefers-reduced-motion: reduce) { #runner-shelf { transition: none } }
`

/**
 * `/v/{version}/…` is resolved by string construction: the shell below emits
 * version-pinned URLs, so nothing after the document has to ask what the live
 * version is. The one thing it does ask is whether the named version is a
 * release we finished importing — see `servable` — because the path is
 * caller-supplied and everything under it is cached for a year.
 *
 * It is also what keeps the app's own state out of reach. `record.json` sits in
 * the same prefix as the bytes we serve, and the fixed `version` and `files`
 * segments are what a request path cannot climb out of: an R2 key is an opaque
 * string, so a `..` in one is a character, never a parent directory.
 */
const versioned = (id: string, version: string) => `apps/${id}/${version}`

/**
 * The manifest and everything under `/v/` is readable by any origin.
 *
 * A desktop installs a hosted app by fetching `/manifest.json` from another
 * origin, and mounts its GUI and assets the same way on every cache miss — so
 * without this the whole store is reachable only from the app's own page, which
 * is the one context that does not need it. The pointer needs it as much as the
 * release does: a redirect that fails the CORS check fails the fetch that
 * followed it.
 *
 * `*` rather than an allowlist because there is nothing here to scope: these
 * bytes are already public, the origin carries no credentials to leak into a
 * cross-origin read, and every file is pinned by digest in the manifest that
 * names it, so a reader that gets the wrong bytes rejects them itself. A
 * literal `*` also needs no `Vary`, which is what keeps this one CDN entry per
 * URL rather than one per requesting origin.
 *
 * Applied after the handler so it covers the 404s too: to a cross-origin
 * caller, a response without this header is a network error rather than a
 * status it can read and report.
 */
const crossOrigin: MiddlewareHandler<Env> = async (c, next) => {
	await next()
	c.res.headers.set('access-control-allow-origin', '*')
}
route.use('/manifest.json', crossOrigin)
route.use('/v/:version/*', crossOrigin)

/**
 * The current release, by redirect — the one route whose answer changes.
 *
 * A client follows it and derives the payload base from where it landed
 * (`new URL('.', response.url)`), which is why `baseUrl` is in no stored
 * document: the URL that served the manifest IS the answer, so a custom domain
 * pins itself with nothing to guess and the app id never enters release data.
 */
route.get('/manifest.json', async (c) => {
	const id = appId(c.req.raw, c.env)
	const version = id ? (await readRecord(c.env, id))?.current : null
	if (!version) return c.notFound()
	c.header('cache-control', POINTER)
	return c.redirect(`/v/${version}/manifest.json`, 302)
})

route.get('/v/:version/*', async (c) => {
	const id = appId(c.req.raw, c.env)
	const version = c.req.param('version')
	if (!id || !(await servable(c.env, id, version))) return c.notFound()
	const path = c.req.path.slice(`/v/${version}/`.length)

	// The canonical manifest sits BESIDE the payload rather than inside it, because
	// the bundle's authored manifest is control metadata that we never rehost — so
	// this one name resolves one level up, and an app is free to ship a file called
	// anything else, `worker.js` included.
	const key =
		path === 'manifest.json'
			? `${versioned(id, version)}/manifest.json`
			: `${versioned(id, version)}/files/${path}`

	// Streamed straight through, so a 10 MB bundle never becomes a 10 MB string
	// in a 128 MB isolate — and what a device verifies is what we stored.
	const body = (await c.env.STORE.get(key))?.body
	if (!body) return c.notFound()
	return c.body(body, 200, { 'content-type': mime(path), 'cache-control': IMMUTABLE })
})

/**
 * The reducer isolate: host code, byte-identical for every app and every release.
 *
 * It belongs to the shell rather than to a release, so it is not under `/v/`: the
 * page hands it the reducer's version-pinned URL as the Worker's `name`, and it
 * dynamic-imports that. One body, and no per-release copy of platform code.
 *
 * `no-cache` because it changes with host deployments — a cached one against a
 * newer shell is a protocol mismatch nobody can clear from the server side.
 */
route.get('/worker.js', (c) =>
	c.body(sandboxWorkerSource(null, 'web'), 200, {
		'content-type': MIME.js as string,
		'cache-control': 'no-cache',
		'content-security-policy': WORKER_CSP
	})
)

route.get('/gui-frame', (c) =>
	c.body(GUI_FRAME, 200, {
		'content-type': MIME.html as string,
		'cache-control': 'no-cache',
		'content-security-policy': guestCsp(new URL('/v/', c.req.url).href)
	})
)

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
 * Named `.webmanifest`, not `manifest.json`: that name already means this app's
 * release manifest, which is served from `/v/{version}/`.
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

/** The one page, and the one route that asks what the live version is. */
route.get('/', async (c) => {
	const id = appId(c.req.raw, c.env)
	const app = id ? await findApp(c.env, id) : null
	if (!app) return c.notFound()

	const base = `/v/${app.version}/`
	const request = new URL(c.req.url)
	const local = request.hostname.endsWith('.localhost')
	const home = local
		? `${request.protocol}//localhost${request.port ? `:${request.port}` : ''}/`
		: `https://${c.env.ROOT_DOMAIN}/`
	c.header('content-security-policy', PAGE_CSP(local))
	return c.html(
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{app.name}</title>
				<link rel="manifest" href="/manifest.webmanifest" />
				<style>{raw(SHELL_STYLE)}</style>
				<ViteClient />
				<Script src="/src/client/main.ts" />
			</head>
			<body>
				<nav id="runner-shelf" aria-label="App navigation">
					<span class="runner-shelf-icon" aria-hidden="true">
						{app.icon ? <img src={`${base}${app.icon}`} alt="" /> : app.name.slice(0, 1)}
					</span>
					<span class="runner-shelf-name">{app.name}</span>
					<span class="runner-shelf-dot"></span>
					<span class="runner-shelf-host">{c.env.ROOT_DOMAIN}</span>
					<a class="runner-shelf-home" href={home} aria-label="All apps">
						<span class="runner-shelf-dots" aria-hidden="true">
							<i></i>
							<i></i>
							<i></i>
							<i></i>
						</span>
						Apps
					</a>
				</nav>
				{/* The mount point, carrying the app's identity, the entry points its
				    manifest declares, AND the version-pinned origin its bytes come from:
				    resolving the live version is this request's job, so the page inherits
				    the answer rather than asking again — and every URL the client builds
				    stays pinned to the release this document was rendered for. */}
				<div
					id="app"
					data-id={app.id}
					data-name={app.name}
					data-version={app.version}
					data-base={base}
					data-app={app.app}
					data-gui={app.gui}
				>
					{/* Browsers do not fire submit events without `allow-forms`. The guest CSP
					    still blocks native form requests. */}
					<iframe id="app-frame" title={app.name} sandbox="allow-scripts allow-forms"></iframe>
					<div id="app-error" role="alert" hidden></div>
				</div>
			</body>
		</html>
	)
})
