// quayd — the Node backend daemon. Slice 5: mount the Volume, build the kernel,
// seed the built-in catalog, and serve the real `kernel.list()` over the socket
// (plus a debug `ls` of the Volume). Slice 6: project that catalog into the OS as
// real `.app` bundles. Slice 7: serve each app's assets over http and a token-
// scoped Cap'n Web berth (dispatch/state/subscribe) so a window renders its real
// `gui.js` and an action round-trips. Slice 8: a window opening/closing pins/evicts
// that app's reducer worker. Slice 9: the kernel carries an in-process capability
// registry (`volume`), so a capability-using app (Files) reaches real files.
// Slice 10: `@justfiles/agent` runs here too, driving real `.app` bundles and the
// same kernel the berths subscribe to; the launcher hosts its chat over this socket.
// Slice 11: Code's `devkit.install` writes a new app into the kernel and fires
// `onInstalled`; the daemon re-materialises the `.app` projection and pushes the
// launcher a fresh catalog, so a freshly-built app shows up in both Spotlight and the
// launcher with no app-code change.

import { randomBytes } from 'node:crypto'
import type { Channel } from '@justfiles/app/capabilities/notify'
import { createQuayAgent } from './agent.ts'
import { launcherCatalog } from './catalog.ts'
import { clearRuntime, writeRuntime } from './discovery.ts'
import { createHost } from './host.ts'
import { reconcileProjection } from './materialize.ts'
import { type Backend, serve } from './server.ts'

// Re-materialise the OS projection + re-list the launcher after an install. Bound to
// the real `served` once the server is up (an install can only arrive over a socket).
let onInstalled: () => Promise<void> = async () => {}
// The notification channel, bound deferred to `served.notify` once the server is up
// (a notification can only reach a launcher over a socket). The closures handed to
// the host and agent forward through this mutable binding.
let channel: Channel = () => {}
const host = await createHost(
	undefined,
	() => onInstalled(),
	(n) => channel(n)
)
const agent = await createQuayAgent(host, undefined, (n) => channel(n))

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

const token = randomBytes(16).toString('hex')

const exit = async () => {
	await clearRuntime()
	process.exit(0)
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

// Project the catalog into ~/Applications/Quay Apps/ so the apps are real macOS apps
// (Spotlight/Launchpad/Raycast), launchable even with the launcher closed. One-way,
// Volume wins; failure is non-fatal (the socket catalog still works). The same
// reconcile runs after each install (`onInstalled`) so a freshly-built app projects
// out and the launcher re-lists immediately.
const project = async () => {
	const apps = visible(await host.kernel.list())
	await reconcileProjection(apps).catch((error) => console.error('quayd: projection failed', error))
}
onInstalled = async () => {
	await project()
	await served.broadcastCatalog()
}

const apps = visible(await host.kernel.list())
console.log(`quayd listening on ws://127.0.0.1:${served.port}`)
console.log(`kernel apps: ${apps.map((app) => app.id).join(', ') || '(none)'}`)
await project()

process.on('SIGINT', exit)
process.on('SIGTERM', exit)
