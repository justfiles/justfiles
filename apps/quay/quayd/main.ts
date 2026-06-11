// quayd — the Node backend daemon. Slice 5: mount the Volume, build the kernel,
// seed the built-in catalog, and serve the real `kernel.list()` over the socket
// (plus a debug `ls` of the Volume). Slice 6: project that catalog into the OS as
// real `.app` bundles. Slice 7: serve each app's assets over http and a token-
// scoped Cap'n Web berth (dispatch/state/subscribe) so a window renders its real
// `gui.js` and an action round-trips. Slice 8: a window opening/closing pins/evicts
// that app's reducer worker. Slice 9: the kernel carries an in-process capability
// registry (`volume`), so a capability-using app (Finder) reaches real files.
// Slice 10: `@justfiles/agent` runs here too, driving real `.app` bundles and the
// same kernel the berths subscribe to; the launcher hosts its chat over this socket.

import { randomBytes } from 'node:crypto'
import { createQuayAgent } from './agent.ts'
import { clearRuntime, writeRuntime } from './discovery.ts'
import { createHost } from './host.ts'
import { reconcileProjection } from './materialize.ts'
import { type Backend, serve } from './server.ts'

const host = await createHost()
const agent = await createQuayAgent(host)

const backend: Backend = {
	async list() {
		return (await host.kernel.list()).map((app) => ({
			id: app.id,
			name: app.name,
			glyph: app.name.slice(0, 1).toUpperCase()
		}))
	},
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
	agent: {
		history: () => agent.history(),
		prompt: (text) => agent.prompt(text),
		abort: () => agent.abort()
	}
}

const token = randomBytes(16).toString('hex')

const exit = async () => {
	await clearRuntime()
	process.exit(0)
}

const { port } = await serve(backend, {
	token,
	onIdle: exit,
	// A window opening/closing pins/evicts that app's reducer worker (Slice 8).
	windows: { open: host.sandbox.retain, close: host.sandbox.release }
})
await writeRuntime({ port, token, pid: process.pid })
const apps = await host.kernel.list()
console.log(`quayd listening on ws://127.0.0.1:${port}`)
console.log(`kernel apps: ${apps.map((app) => app.id).join(', ') || '(none)'}`)

// Project the catalog into ~/Applications/Quay Apps/ so the apps are real macOS
// apps (Spotlight/Launchpad/Raycast), launchable even with the launcher closed.
// One-way, Volume wins; failure is non-fatal (the socket catalog still works).
await reconcileProjection(apps).catch((error) => console.error('quayd: projection failed', error))

process.on('SIGINT', exit)
process.on('SIGTERM', exit)
