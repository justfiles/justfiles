// quayd — the Node backend daemon. Slice 5: mount the Volume, build the kernel,
// seed the built-in catalog, and serve the real `kernel.list()` over the socket
// (plus a debug `ls` of the Volume). Discovery + idle-exit are from Slice 4; the
// `.app` projection, asset serving, sandbox, capabilities and agent follow.

import { randomBytes } from 'node:crypto'
import { clearRuntime, writeRuntime } from './discovery.ts'
import { createHost } from './host.ts'
import { type Backend, serve } from './server.ts'

const host = await createHost()

const backend: Backend = {
	async list() {
		return (await host.kernel.list()).map((app) => ({
			id: app.id,
			name: app.name,
			glyph: app.name.slice(0, 1).toUpperCase()
		}))
	},
	ls: (path) => host.fs.readdir(path)
}

const token = randomBytes(16).toString('hex')

const exit = async () => {
	await clearRuntime()
	process.exit(0)
}

const { port } = await serve(backend, { token, onIdle: exit })
await writeRuntime({ port, token, pid: process.pid })
const apps = await host.kernel.list()
console.log(`quayd listening on ws://127.0.0.1:${port}`)
console.log(`kernel apps: ${apps.map((app) => app.id).join(', ') || '(none)'}`)

process.on('SIGINT', exit)
process.on('SIGTERM', exit)
