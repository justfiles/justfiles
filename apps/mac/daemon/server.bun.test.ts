// Server/protocol coverage — main.ts exports
// `createServer` (the Bun.serve routing + the three sockets); this stands one up over a
// throwaway temp Volume (FRIEREN_SUPPORT_DIR) with a no-op `projectApps` so the run never
// touches ~/Applications. It exercises the HTTP routes (per-app gui.js/icon + their 404s +
// the serveClient guard, the App Store's `/store` browse + install over a faked JustApps
// registry) and the wire protocol on all three sockets: `/system` (catalog + command
// dispatch), `/agent` (live transcript + a prompt turn), and `/app/:id` (initial state + a
// dispatch round-trip). Offline-safe: with no ai account the agent can't build, so history is
// empty and a prompt turn surfaces a classified error — both observable here. One server per
// process, because the daemon's kernel/Volume are module singletons.
// Bun-only (`bun test`): Bun.serve + pub/sub + blob-URL reducer workers.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	RUNNER_MANIFEST_SCHEMA,
	RUNNER_STORE_SCHEMA,
	RUNNER_STORE_URL
} from '../../shared/justapps.ts'
import { getKernel } from './kernel.ts'
import { createServer } from './main.ts'

const FILES = 'justfiles.files'
let root: string
let server: ReturnType<typeof createServer>
let port: number

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'daemon-server-'))
	// Sandbox the daemon's Volume/agent singletons to the temp dir before the first use.
	process.env.FRIEREN_SUPPORT_DIR = root
	// Ephemeral port; a no-op projection so the run never writes ~/Applications/Kodama Apps.
	server = createServer({ port: 0, projectApps: async () => {} })
	if (server.port === undefined) throw new Error('server has no TCP port')
	port = server.port
})
afterAll(async () => {
	server.stop(true)
	delete process.env.FRIEREN_SUPPORT_DIR
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
	state?: {
		count?: number
		currentViewing?: string | null
		revision?: number
		error?: string | null
	}
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

test('serves an app icon, 404s an unknown app', async () => {
	const icon = await fetch(`http://127.0.0.1:${port}/app/${FILES}/icon`) // Files ships icon.png
	expect(icon.status).toBe(200)
	expect(icon.headers.get('content-type')).toContain('image/')

	const none = await fetch(`http://127.0.0.1:${port}/app/does.not.exist/icon`)
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
	const client = await connect(`/app/${FILES}/connect`)
	const initial = await client.waitFor((m) => m.state !== undefined)
	// What's under test is the socket pushing Files' initial state, not Files' full state.
	expect(initial.state).toMatchObject({ currentViewing: null, revision: 0 })

	client.send({ id: 'r1', type: 'setView', params: { path: '/hello.txt' } })
	const reply = await client.waitFor((m) => m.id === 'r1')
	expect(reply.ok).toBe(true)
	// The mutation fans back out on the app's topic as a fresh state push.
	const pushed = await client.waitFor((m) => m.state?.currentViewing === '/hello.txt')
	expect(pushed.state).toMatchObject({ currentViewing: '/hello.txt' })
	client.close()
})

// A fake JustApps registry: one published app, served from an immutable release URL. The
// daemon reads the registry through the global `fetch`, so `withRegistry` patches it for
// the duration of a test and passes everything else (this test's own requests to the
// server) through to the real one.
const TASKS = 'com.example.tasks'
const RELEASE = 'https://com-example-tasks.justapps.run/v/1.0.0/'
const POINTER = 'https://com-example-tasks.justapps.run/manifest.json'
const files: Record<string, string> = { 'app.js': 'REDUCER', 'gui.js': 'GUI' }
const index = {
	schema: RUNNER_STORE_SCHEMA,
	apps: [
		{
			id: TASKS,
			name: 'Tasks',
			description: 'Track things',
			version: '1.0.0',
			manifestUrl: POINTER,
			repository: 'https://example.com/tasks'
		}
	]
}
const release = {
	schema: RUNNER_MANIFEST_SCHEMA,
	id: TASKS,
	name: 'Tasks',
	description: 'Track things',
	version: '1.0.0',
	app: 'app.js',
	gui: 'gui.js',
	capabilities: { volume: { id: 'volume', scopes: ['read'] } },
	hash: 'release-hash',
	files: Object.entries(files).map(([path, body]) => ({
		path,
		hash: `sha256-${createHash('sha256').update(body).digest('hex')}`,
		size: body.length
	}))
}

async function withRegistry<T>(run: () => Promise<T>): Promise<T> {
	const real = globalThis.fetch
	const json = (data: unknown, url: string): Response => {
		const response = new Response(JSON.stringify(data))
		// `runnerAppStore` pins an app's baseUrl to the URL its manifest came back from.
		Object.defineProperty(response, 'url', { value: url })
		return response
	}
	globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
		if (url === RUNNER_STORE_URL) return Promise.resolve(json(index, RUNNER_STORE_URL))
		if (url === POINTER) return Promise.resolve(json(release, `${RELEASE}manifest.json`))
		if (url.startsWith(RELEASE)) {
			const body = files[url.slice(RELEASE.length)]
			return Promise.resolve(
				body === undefined ? new Response(null, { status: 404 }) : new Response(body)
			)
		}
		return real(input, init)
	}) as typeof fetch
	try {
		return await run()
	} finally {
		globalThis.fetch = real
	}
}

test('/store lists what JustApps publishes, without the file manifests', async () => {
	const apps = await withRegistry(async () => {
		const res = await fetch(`http://127.0.0.1:${port}/store`)
		expect(res.status).toBe(200)
		return ((await res.json()) as { apps: Record<string, unknown>[] }).apps
	})

	expect(apps).toEqual([
		{
			id: TASKS,
			name: 'Tasks',
			description: 'Track things',
			version: '1.0.0',
			repository: 'https://example.com/tasks',
			capabilities: release.capabilities
		}
	])
})

test('POST /store/:id installs a published app, and 502s an unknown one', async () => {
	await withRegistry(async () => {
		const res = await fetch(`http://127.0.0.1:${port}/store/${TASKS}`, { method: 'POST' })
		expect(res.status).toBe(204)

		const kernel = await getKernel()
		expect((await kernel.list()).map((app) => app.id)).toContain(TASKS)
		// Hosted: the record and the reducer land in the Volume, the GUI stays mounted.
		const installed = await kernel.app(TASKS)
		expect(installed.manifest.baseUrl).toBe(RELEASE)
		expect(new TextDecoder().decode(await installed.read('gui.js'))).toBe('GUI')

		const missing = await fetch(`http://127.0.0.1:${port}/store/no.such.app`, { method: 'POST' })
		expect(missing.status).toBe(502)
	})
})
