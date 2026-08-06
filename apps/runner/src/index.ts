import { Hono } from 'hono'
import { html } from 'hono/html'
import { appId, route as appSite } from './app'

type Env = { Bindings: CloudflareBindings }

/** `<app>.<root>`: one whole site per app — its page, its worker, its assets. */

/** The root domain: the runner itself, no app in sight. */
const rootSite = new Hono<Env>()

rootSite.get('/', (c) => c.html(html`<h1>runner</h1>`))

export default {
	// The host picks the site, so app routes exist only on app hosts and vice versa.
	fetch: (req: Request, env: CloudflareBindings, ctx: ExecutionContext) =>
		(appId(req, env) ? appSite : rootSite).fetch(req, env, ctx)
}
