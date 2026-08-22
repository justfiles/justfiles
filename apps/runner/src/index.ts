import { route as appSite } from './app'
import { cleanExpired } from './auth/cleanup'
import { d1 } from './auth/db'
import { refresh } from './catalog'
import { seed } from './catalog/seed'
import { route as rootSite } from './home'
import { appId } from './origin'

/** `<app>.<root>`: one whole site per app — its page, its worker, its assets. */

export default {
	// The host picks the site, so app routes exist only on app hosts and vice versa.
	fetch: async (req: Request, env: CloudflareBindings, ctx: ExecutionContext) => {
		if (import.meta.env.DEV && import.meta.env.MODE !== 'test') await seed(env.STORE)
		return (appId(req, env) ? appSite : rootSite).fetch(req, env, ctx)
	},

	// The reconcile runs on the cron trigger in wrangler.jsonc, hourly — an
	// interval of an hour or more gets 15 minutes of CPU, where anything shorter
	// gets 30 seconds. `waitUntil` keeps it alive past the tick.
	scheduled: (_controller: ScheduledController, env: CloudflareBindings, ctx: ExecutionContext) => {
		ctx.waitUntil(Promise.all([refresh(env), cleanExpired(d1(env.AUTH_DB))]))
	}
} satisfies ExportedHandler<CloudflareBindings>
