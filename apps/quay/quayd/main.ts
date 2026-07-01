// quayd — the legacy Node backend daemon (superseded by daemon/; kept as a fallback).
// Slice 5: mount the Volume, build the kernel, seed the built-in catalog, and serve the
// real `kernel.list()` over the socket (plus a debug `ls` of the Volume). Slice 7: serve
// each app's assets over http and a token-scoped Cap'n Web berth (dispatch/state/
// subscribe) so a window renders its real `gui.js` and an action round-trips. Slice 8: a
// window opening/closing pins/evicts that app's reducer worker. Slice 9: the kernel
// carries an in-process capability registry (`volume`), so a capability-using app (Files)
// reaches real files. Slice 10: `@justfiles/agent` runs here too, driving real `.app`
// bundles and the same kernel the berths subscribe to; the launcher hosts its chat over
// this socket. Slice 11: Code's `devkit.install` writes a new app into the kernel. (This
// legacy daemon no longer reacts to installs — the current daemon re-lists off the
// kernel's `app.installed` event; the OS `.app` projection moved to daemon/materialize.ts.)

import { randomBytes } from 'node:crypto'
import type { Channel } from '@justfiles/app/capabilities/notify'
import { createQuayAgent } from './agent.ts'
import { launcherCatalog } from './catalog.ts'
import { clearRuntime, writeRuntime } from './discovery.ts'
import { createHost } from './host.ts'
import { type Backend, serve } from './server.ts'

// The notification channel, bound deferred to `served.notify` once the server is up
// (a notification can only reach a launcher over a socket). The closures handed to
// the host and agent forward through this mutable binding.
let channel: Channel = () => {}
const token = randomBytes(16).toString('hex')
const host = await createHost(
	undefined,
	(n) => channel(n),
	(id) => `/app/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`
)
const agent = await createQuayAgent(host, (n) => channel(n))

// Preview apps (`preview.<slug>`) are app-code's transient live previews — installed
// in the kernel so they serve a gui + berth, but never shown in the launcher or
// projected to the OS.
const visible = <T extends { id: string }>(apps: T[]): T[] =>
	apps.filter((app) => !app.id.startsWith('preview.'))

const backend: Backend = {
	list: () => launcherCatalog(host.kernel),
	ls: (path) => host.fs.readdir(path),
	gui: async (id) => (await host.kernel.app(id)).read('gui.js'),
	// The berth seam: dispatch/state into the same kernel the agent drives, and a
	// per-app subscription off `app.update` so updates fan out to the GUI live.
	state: (id) => host.kernel.state(id),
	dispatch: (id, message) => host.kernel.dispatch(id, message as never),
	subscribe: (id, onState) =>
		host.kernel.subscribe((event) => {
			if (event.type === 'app.update' && event.appId === id) onState(event.state)
		}),
	// The launcher's chat: prompt/history over the privileged socket. The agent
	// `app run`s into this same kernel, so an open window's berth re-renders live.
	agent
}

const exit = async () => {
	await clearRuntime()
	process.exit(0)
}

// Bind our lifetime to the owning app. The launcher passes its PID as QUAY_OWNER_PID when
// it spawns us (booters don't, so a Spotlight-launched window's daemon outlives it). macOS
// has no parent-death signal, so we poll: kill(pid,0) is a cheap liveness probe, and when
// the owner is gone — quit OR hard kill — we exit too. ESRCH ⟹ gone; EPERM ⟹ alive.
const ownerPid = Number(process.env.QUAY_OWNER_PID)
if (Number.isInteger(ownerPid) && ownerPid > 0) {
	const watchdog = setInterval(() => {
		try {
			process.kill(ownerPid, 0)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EPERM') void exit()
		}
	}, 1000)
	watchdog.unref()
}

const served = await serve(backend, {
	token,
	onIdle: exit,
	// A window opening/closing pins/evicts that app's reducer worker (Slice 8).
	windows: { open: host.sandbox.retain, close: host.sandbox.release }
})
// Bind the deferred channel now the server is up: host/agent notifications fan out
// to the launcher sockets (the native sink projects them onto the OS banner).
channel = served.notify
await writeRuntime({ port: served.port, token, pid: process.pid })

const apps = visible(await host.kernel.list())
console.log(`quayd listening on ws://127.0.0.1:${served.port}`)
console.log(`kernel apps: ${apps.map((app) => app.id).join(', ') || '(none)'}`)

process.on('SIGINT', exit)
process.on('SIGTERM', exit)
