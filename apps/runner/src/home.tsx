import { Hono } from 'hono'
import { listApps, refresh } from './catalog'
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

const STYLE = `
:root { color-scheme: light dark; --bg: #fff; --fg: #16161a; --muted: #6b6b76; --card: #f7f7f8; --line: #e6e6ea }
@media (prefers-color-scheme: dark) { :root { --bg: #111114; --fg: #f2f2f4; --muted: #9a9aa6; --card: #1a1a1f; --line: #2a2a31 } }
body { background: var(--bg); color: var(--fg); font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0 auto; max-width: 44rem; padding: 4rem 1.5rem }
h1 { font-size: 1.5rem; letter-spacing: -0.01em; margin: 0 }
header { align-items: start; display: flex; gap: 1rem; justify-content: space-between }
.lede { color: var(--muted); margin: 0.5rem 0 2.5rem }
button { background: var(--card); border: 1px solid var(--line); border-radius: 0.5rem; color: inherit; cursor: pointer; font: inherit; padding: 0.5rem 0.75rem }
button:hover { border-color: var(--muted) }
ul { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr)); list-style: none; margin: 0; padding: 0 }
a { align-items: center; background: var(--card); border: 1px solid var(--line); border-radius: 0.75rem; color: inherit; display: flex; gap: 0.875rem; padding: 1rem; text-decoration: none }
a:hover { border-color: var(--muted) }
img, .icon { border-radius: 0.5rem; flex: none; height: 48px; object-fit: cover; width: 48px }
.icon { background: var(--line) }
.text { display: flex; flex-direction: column; min-width: 0 }
.name { font-weight: 600 }
.meta { color: var(--muted); font-size: 0.8125rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
`

/** The index: every app we host, each linking to the origin that serves it. */
route.get('/', async (c) => {
	const apps = await listApps(c.env)
	return c.html(
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{c.env.ROOT_DOMAIN}</title>
				<style>{STYLE}</style>
			</head>
			<body>
				<header>
					<div>
						<h1>Apps</h1>
						<p class="lede">Everything hosted on {c.env.ROOT_DOMAIN}, one origin each.</p>
					</div>
					<form method="post" action="/refresh">
						<button type="submit">Refresh</button>
					</form>
				</header>
				{apps.length === 0 ? (
					<p class="lede">Nothing published yet.</p>
				) : (
					<ul>
						{apps.map((app) => {
							const url = appUrl(c.req.raw, c.env, app.id)
							return (
								<li>
									<a href={url}>
										{/* The icon comes from the app's own origin, version-pinned like
										    every other byte of it — the runner keeps no copy outside the
										    release it belongs to. */}
										{app.icon ? (
											<img
												src={`${url}v/${app.version}/${app.icon}`}
												alt=""
												width="48"
												height="48"
											/>
										) : (
											<span class="icon"></span>
										)}
										<span class="text">
											<span class="name">{app.name}</span>
											<span class="meta">
												{app.id} · {app.version}
											</span>
										</span>
									</a>
								</li>
							)
						})}
					</ul>
				)}
			</body>
		</html>
	)
})

route.post('/refresh', async (c) => {
	await refresh(c.env)
	return c.redirect('/', 303)
})

// Running the reconcile on demand, and seeing what it decided. `import.meta.env.DEV`
// is a compile-time constant, so `vite build` eliminates this branch outright —
// production ships no debug route at all, rather than one behind a runtime check.
if (import.meta.env.DEV) {
	route.get('/debug/refresh', async (c) => c.json(await refresh(c.env)))
}
