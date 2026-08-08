import { appId, route as appSite } from './app'
import { refresh } from './catalog'
import { route as rootSite } from './home'

/** `<app>.<root>`: one whole site per app — its page, its worker, its assets. */

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
