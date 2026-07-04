// Server/protocol coverage — main.ts exports
// `createServer` (the Bun.serve routing + the three sockets); this stands one up over a
// throwaway temp Volume (SPUD_SUPPORT_DIR) with a no-op `projectApps` so the run never
// touches ~/Applications. It exercises the HTTP routes (per-app gui.js/icon + their 404s +
// the serveClient guard) and the wire protocol on all three sockets: `/system` (catalog +
// command dispatch), `/agent` (live transcript + a prompt turn), and `/app/:id` (initial
// state + a dispatch round-trip). Offline-safe: with no ai account the agent can't build, so
// history is empty and a prompt turn surfaces a classified error — both observable here.
// Bun-only (`bun test`): Bun.serve + pub/sub + blob-URL reducer workers.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from './main.ts'

const COUNTER = 'app.justfiles.counter'
const FILES = 'app.frieren.files'
let root: string
let server: ReturnType<typeof createServer>
let port: number

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'daemon-server-'))
	// Sandbox the daemon's Volume/agent singletons to the temp dir before the first use.
	process.env.SPUD_SUPPORT_DIR = root
	// Ephemeral port; a no-op projection so the run never writes ~/Applications/Spud Apps.
	server = createServer({ port: 0, projectApps: async () => {} })
	if (server.port === undefined) throw new Error('server has no TCP port')
	port = server.port
})
afterAll(async () => {
	server.stop(true)
	delete process.env.SPUD_SUPPORT_DIR
	await rm(root, { recursive: true, force: true })
})

// A socket wrapper that buffers every frame (so a message that lands before a waiter is
// attached is never missed — the /system + /agent sockets push on connect) and lets a test
// await the first frame matching a predicate.
interface Frame {
	type?: string
	apps?: { id: string }[]
	commands?: { name: string }[]
	id?: string
	ok?: boolean
	result?: { show: string; body?: string }
	entries?: unknown[]
	value?: boolean
	message?: string
	state?: { count: number }
}

interface Client {
	send(value: unknown): void
	waitFor(pred: (m: Frame) => boolean, timeoutMs?: number): Promise<Frame>
	close(): void
}

function connect(path: string): Promise<Client> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
	const messages: Frame[] = []
	const waiters: { pred: (m: Frame) => boolean; resolve: (m: Frame) => void }[] = []
	ws.addEventListener('message', (event) => {
		const m = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) as Frame
		messages.push(m)
		for (let i = waiters.length - 1; i >= 0; i--) {
			if (waiters[i].pred(m)) {
				waiters[i].resolve(m)
				waiters.splice(i, 1)
			}
		}
	})
	return new Promise((resolve, reject) => {
		ws.addEventListener('error', reject)
		ws.addEventListener('open', () =>
			resolve({
				send: (value) => ws.send(JSON.stringify(value)),
				waitFor: (pred, timeoutMs = 5000) => {
					const found = messages.find(pred)
					if (found) return Promise.resolve(found)
					return new Promise((res, rej) => {
						const timer = setTimeout(() => rej(new Error('timed out waiting for frame')), timeoutMs)
						waiters.push({
							pred,
							resolve: (m) => {
								clearTimeout(timer)
								res(m)
							}
						})
					})
				},
				close: () => ws.close()
			})
		)
	})
}

test('serves gui.js bytes for an installed app, 404s an unknown one', async () => {
	const res = await fetch(`http://127.0.0.1:${port}/app/${FILES}/gui.js`)
	expect(res.status).toBe(200)
	expect(res.headers.get('content-type')).toContain('javascript')
	expect((await res.text()).length).toBeGreaterThan(0)

	const missing = await fetch(`http://127.0.0.1:${port}/app/does.not.exist/gui.js`)
	expect(missing.status).toBe(404)
})

test('serves an app icon, 404s an app with none', async () => {
	const icon = await fetch(`http://127.0.0.1:${port}/app/${FILES}/icon`) // Files ships icon.png
	expect(icon.status).toBe(200)
	expect(icon.headers.get('content-type')).toContain('image/')

	const none = await fetch(`http://127.0.0.1:${port}/app/${COUNTER}/icon`) // counter has no icon
	expect(none.status).toBe(404)
})

test('404s a missing client asset (serveClient exists guard)', async () => {
	const res = await fetch(`http://127.0.0.1:${port}/no-such-asset.js`)
	expect(res.status).toBe(404)
})

test('/system pushes the catalog + command menu on connect', async () => {
	const client = await connect('/system')
	const apps = await client.waitFor((m) => m.type === 'apps')
	expect((apps.apps ?? []).map((a) => a.id)).toContain(FILES)

	const commands = await client.waitFor((m) => m.type === 'commands')
	// The built-ins are always present (skills add to them); dispatch rides this socket.
	const names = (commands.commands ?? []).map((c) => c.name)
	expect(names).toContain('new')
	expect(names).toContain('debug')
	client.close()
})

test('/system dispatches a command and replies with what to show', async () => {
	const client = await connect('/system')
	await client.waitFor((m) => m.type === 'commands') // settle the connect frames first

	// `/debug` renders a one-off text panel; offline (no ai account) the report is the
	// "agent unavailable" fallback, but it still round-trips as a text result keyed by id.
	client.send({ type: 'command', id: 'd1', name: 'debug' })
	const debug = await client.waitFor((m) => m.type === 'commandResult' && m.id === 'd1')
	expect(debug.result?.show).toBe('text')
	expect(typeof debug.result?.body).toBe('string')

	// `/new` clears the session and reveals the chat.
	client.send({ type: 'command', id: 'n1', name: 'new' })
	const fresh = await client.waitFor((m) => m.type === 'commandResult' && m.id === 'n1')
	expect(fresh.result).toEqual({ show: 'chat' })
	client.close()
})

test('/agent snapshots history + busy on connect, and a prompt runs a turn', async () => {
	const client = await connect('/agent')
	// Offline the shared session can't build, so the snapshot is an empty transcript.
	const history = await client.waitFor((m) => m.type === 'history')
	expect(history.entries).toEqual([])
	await client.waitFor((m) => m.type === 'busy' && m.value === false)

	// A prompt drives a turn on the shared session; with no backend it fails, so the turn
	// broadcasts busy → a classified error → busy:false. We observe the error frame.
	client.send({ type: 'prompt', text: 'hello' })
	const error = await client.waitFor((m) => m.type === 'error')
	expect(typeof error.message).toBe('string')
	expect((error.message ?? '').length).toBeGreaterThan(0)
	client.close()
})

test('/app socket pushes initial state and round-trips a dispatch', async () => {
	const client = await connect(`/app/${COUNTER}/connect`)
	const initial = await client.waitFor((m) => m.state !== undefined)
	expect(initial.state).toEqual({ count: 0 })

	client.send({ id: 'r1', type: 'increment', params: { amount: 2 } })
	const reply = await client.waitFor((m) => m.id === 'r1')
	expect(reply.ok).toBe(true)
	// The mutation fans back out on the app's topic as a fresh state push.
	const pushed = await client.waitFor((m) => m.state?.count === 2)
	expect(pushed.state).toEqual({ count: 2 })
	client.close()
})
