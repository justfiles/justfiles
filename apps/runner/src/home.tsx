import { Hono } from 'hono'
import { raw } from 'hono/html'
import { readStore, refresh } from './catalog'
import { encodeLabel } from './id'

type Env = { Bindings: CloudflareBindings }

/** The root domain: the runner itself, no app in sight. */
export const route = new Hono<Env>()

/**
 * Where an app is served. Absolute, because the index is the one page here that
 * has to name origins other than its own.
 *
 * Built from `ROOT_DOMAIN` rather than from the host this request arrived on:
 * the root site also answers at hosts no app is served under — the `workers.dev`
 * name, `www`, anything deeper than one label — and a link relative to one of
 * those would point at a host that does not exist. `*.localhost` is the one
 * exception, since `wrangler dev` has no zone; the app site special-cases it in
 * exactly the same way.
 */
const appUrl = (req: Request, env: CloudflareBindings, id: string): string => {
	const url = new URL(req.url)
	const label = encodeLabel(id)
	return url.hostname === 'localhost'
		? `${url.protocol}//${label}.${url.host}/`
		: `https://${label}.${env.ROOT_DOMAIN}/`
}

/**
 * The tile color for an app that publishes no icon, taken from its id so it is
 * the same on every render. A grid of monograms only reads as a grid if the
 * tiles differ; one shared gray reads as a row of holes.
 */
const HUES = ['#3a6ea5', '#4b7f52', '#a9683a', '#8b5ea8', '#b4565a', '#2f7d7a']
const hue = (id: string) =>
	HUES[[...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % HUES.length]

/**
 * A springboard: one field of icons, and a search pill above it that survives an
 * empty store and never moves as the grid grows. Designed in
 * `kb/design/springboard.md`.
 *
 * The phone breakpoint pins four columns rather than letting `auto-fill` decide,
 * which at that width gives three fat ones and a page that reads as a list.
 */
const STYLE = `
:root { color-scheme: light dark;
	--wash: rgba(255, 209, 163, .5); --bg1: #eef1f6; --bg2: #dfe5ef; --ink: #1b1f26; --dim: #6d7481;
	--pill: rgba(255,255,255,.72); --edge: rgba(24,32,56,.10); --cast: rgba(24,32,56,.18) }
@media (prefers-color-scheme: dark) { :root {
	--wash: rgba(96,116,190,.28); --bg1: #171a20; --bg2: #0d0f13; --ink: #eceef3; --dim: #949bab;
	--pill: rgba(255,255,255,.06); --edge: rgba(255,255,255,.12); --cast: rgba(0,0,0,.6) } }
/* On the root rather than the body, which is only as wide as the grid: a
   background there leaves the rest of the viewport unpainted. */
html { background: radial-gradient(110% 70% at 50% -8%, var(--wash), transparent 62%),
	linear-gradient(180deg, var(--bg1), var(--bg2)); background-attachment: fixed; color: var(--ink);
	font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif }
body { margin: 0 auto; max-width: 880px; padding: 30px 26px 44px }
h1 { clip-path: inset(50%); height: 1px; margin: 0; overflow: hidden; position: absolute; white-space: nowrap; width: 1px }
.find { align-items: center; backdrop-filter: blur(20px) saturate(1.4); background: var(--pill);
	border: 1px solid var(--edge); border-radius: 999px; box-shadow: 0 1px 2px var(--cast); display: flex;
	gap: 9px; margin: 0 auto 38px; max-width: 340px; padding: 10px 16px }
.find svg { flex: none; opacity: .55 }
input { background: none; border: 0; color: inherit; font: inherit; font-size: 14.5px; outline: none; width: 100% }
input::placeholder { color: inherit; opacity: .45 }
ul { display: grid; gap: 30px 16px; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
	list-style: none; margin: 0; padding: 0 }
a { color: inherit; display: grid; gap: 9px; justify-items: center; text-decoration: none;
	transition: transform .18s ease }
a:hover { transform: translateY(-4px) }
img, .mono { border-radius: 22px; box-shadow: 0 8px 18px -6px var(--cast); height: 74px; object-fit: cover; width: 74px }
.mono { align-items: center; color: #fff; display: flex; font-size: 30px; font-weight: 600; justify-content: center }
.name { font-size: 12.5px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.note { color: var(--dim); font-size: 14px; padding-top: 18px; text-align: center }
@media (max-width: 560px) {
	body { padding: 22px 18px 34px }
	.find { margin-bottom: 26px; max-width: none }
	ul { gap: 26px 6px; grid-template-columns: repeat(4, minmax(0, 1fr)) }
	img, .mono { border-radius: 18px; height: 62px; width: 62px }
}
@media (prefers-reduced-motion: reduce) { a { transition: none } }
`

/**
 * Search is a filter over what the document already carries, not a route: the
 * whole index is one small page, so matching happens on each keystroke against
 * a key rendered onto each item, and nothing is fetched.
 */
const SEARCH = `
const box = document.querySelector('input')
const items = document.querySelectorAll('li')
const none = document.querySelector('.note')
box.addEventListener('input', () => {
	const q = box.value.trim().toLowerCase()
	let hits = 0
	for (const li of items) hits += (li.hidden = !li.dataset.key.includes(q)) ? 0 : 1
	none.hidden = hits > 0
	none.textContent = 'Nothing here matches \\u201C' + box.value.trim() + '\\u201D.'
})
`

/**
 * The browse index.
 *
 * A stored projection rather than a listing assembled per request: the walk over
 * every app happens once per refresh, not once per visitor, so what a client
 * reads is what the last reconcile decided. Readable by any origin — a store
 * front-end is not this one — and cached as briefly as the pointers it carries,
 * since a publish moves both.
 */
route.get('/store.json', async (c) =>
	c.json(await readStore(c.env), 200, {
		'access-control-allow-origin': '*',
		'cache-control': 'public, max-age=60'
	})
)

/** The index: every app we host, each linking to the origin that serves it. */
route.get('/', async (c) => {
	const { apps } = await readStore(c.env)
	return c.html(
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{c.env.ROOT_DOMAIN}</title>
				{/* Raw, both of these: JSX escapes text children, and an escaped quote or
				    `>` is a broken rule or a broken statement. */}
				<style>{raw(STYLE)}</style>
			</head>
			<body>
				<h1>Apps</h1>
				{apps.length === 0 ? (
					<p class="note">Nothing published yet.</p>
				) : (
					<>
						<label class="find">
							<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
								<circle
									cx="7"
									cy="7"
									r="4.5"
									fill="none"
									stroke="currentColor"
									stroke-width="1.6"
								/>
								<path
									d="M10.5 10.5 14 14"
									stroke="currentColor"
									stroke-width="1.6"
									stroke-linecap="round"
								/>
							</svg>
							<input type="search" placeholder="Search apps" aria-label="Search apps" />
						</label>
						<ul>
							{apps.map((app) => {
								// Built from this request's host rather than taken from the stored
								// entry, which is absolute for the benefit of other origins and so
								// names the zone even in local dev. The icon keeps the stored path,
								// which is version-pinned.
								const url = appUrl(c.req.raw, c.env, app.id)
								const icon = app.iconUrl && `${url}${new URL(app.iconUrl).pathname.slice(1)}`
								return (
									<li data-key={`${app.name} ${app.id}`.toLowerCase()}>
										<a href={url}>
											{/* The icon comes from the app's own origin, version-pinned like
											    every other byte of it — the runner keeps no copy outside the
											    release it belongs to. */}
											{icon ? (
												<img src={icon} alt="" width="74" height="74" />
											) : (
												<span class="mono" style={`background: ${hue(app.id)}`}>
													{app.name.slice(0, 1)}
												</span>
											)}
											<span class="name">{app.name}</span>
										</a>
									</li>
								)
							})}
						</ul>
						<p class="note" hidden></p>
						<script>{raw(SEARCH)}</script>
					</>
				)}
			</body>
		</html>
	)
})

// Running the reconcile on demand, and seeing what it decided. `import.meta.env.DEV`
// is a compile-time constant, so `vite build` eliminates this branch outright —
// production ships no debug route at all, rather than one behind a runtime check.
if (import.meta.env.DEV) {
	route.get('/debug/refresh', async (c) => c.json(await refresh(c.env)))
}
