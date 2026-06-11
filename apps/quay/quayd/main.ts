// quayd — the Node backend daemon. Slice 4: listen on 127.0.0.1, advertise via
// runtime.json, and serve a stub catalog over the socket. The kernel, Volume,
// sandboxes, capabilities and agent move in here in later slices.

import { randomBytes } from 'node:crypto'
import { clearRuntime, writeRuntime } from './discovery.ts'
import { type AppInfo, serve } from './server.ts'

// Slice 5 replaces this stub with the kernel's real catalog (kernel.list()).
const catalog: AppInfo[] = [
	{ id: 'code', name: 'Code', glyph: 'C' },
	{ id: 'finder', name: 'Finder', glyph: 'F' },
	{ id: 'paint', name: 'Paint', glyph: 'P' }
]

const token = randomBytes(16).toString('hex')

const exit = async () => {
	await clearRuntime()
	process.exit(0)
}

const { port } = await serve({ list: () => catalog }, { token, onIdle: exit })
await writeRuntime({ port, token, pid: process.pid })
console.log(`quayd listening on ws://127.0.0.1:${port}`)

process.on('SIGINT', exit)
process.on('SIGTERM', exit)
