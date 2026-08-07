import { Hono } from 'hono'
import { html } from 'hono/html'
import { appId, route as appSite } from './app'
import { refresh } from './catalog'

type Env = { Bindings: CloudflareBindings }

/** `<app>.<root>`: one whole site per app — its page, its worker, its assets. */

/** The root domain: the runner itself, no app in sight. */
const rootSite = new Hono<Env>()

rootSite.get('/', (c) => c.html(html`<h1>runner</h1>`))

// Running the reconcile on demand, and seeing what it decided. `import.meta.env.DEV`
// is a compile-time constant, so `vite build` eliminates this branch outright —
// production ships no admin route at all, rather than one behind a runtime check.
if (import.meta.env.DEV) {
	rootSite.get('/debug/refresh', async (c) => c.json(await refresh(c.env)))
}

export default {
	// The host picks the site, so app routes exist only on app hosts and vice versa.
	fetch: (req: Request, env: CloudflareBindings, ctx: ExecutionContext) =>
		(appId(req, env) ? appSite : rootSite).fetch(req, env, ctx),

	// The reconcile runs on the cron trigger in wrangler.jsonc, hourly — an
	// interval of an hour or more gets 15 minutes of CPU, where anything shorter
	// gets 30 seconds. `waitUntil` keeps it alive past the tick.
	scheduled: (_controller: ScheduledController, env: CloudflareBindings, ctx: ExecutionContext) => {
		ctx.waitUntil(refresh(env))
	}
}
