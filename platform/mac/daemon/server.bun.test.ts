// Server/protocol coverage — main.ts exports
// `createServer` (the Bun.serve routing + the three sockets); this stands one up over a
// throwaway temp Volume (FRIEREN_SUPPORT_DIR) with a no-op `projectApps` so the run never
// touches ~/Applications. It exercises the HTTP routes (per-app gui.js/icon + their 404s +
// the serveClient guard, the App Store's `/store` browse + install over a faked JustApps
// registry) and the wire protocol on all three sockets: `/system` (catalog + command
// dispatch), `/agent` (session state + a prompt turn), and `/app/:id` (initial state + a
// dispatch round-trip). Offline-safe: with no ai account the agent can't build, so its state is
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
import { closeStorage } from './fs.ts'
import { getKernel } from './kernel.ts'
import { closeServerRuntime, createServer } from './main.ts'

const FILES = 'justfiles.files'
let root: string
let server: ReturnType<typeof createServer>
let port: number

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'daemon-server-'))
	// Sandbox the daemon's Volume/agent singletons to the temp dir before the first use.
	process.env.FRIEREN_SUPPORT_DIR = root
	// Ephemeral port; a no-op projection so the run never writes ~/Applications/Just Computer Apps.
	server = createServer({ port: 0, token: 'host-test-token', projectApps: async () => {} })
	if (server.port === undefined) throw new Error('server has no TCP port')
	port = server.port
})
afterAll(async () => {
	server.stop(true)
	await closeServerRuntime(server)
	await closeStorage()
	delete process.env.FRIEREN_SUPPORT_DIR
	await rm(root, { recursive: true, force: true })
})

// A socket wrapper that buffers every message so a push that lands before a waiter is
// attached is never missed.
interface Message {
	type?: string
	apps?: { id: string }[]
	commands?: { name: string }[]
	id?: string
	ok?: boolean
	result?: { show?: string; body?: string; status?: 'available' | 'expired'; detail?: unknown }
	requestId?: string
	accepted?: boolean
	history?: unknown[]
	status?: { state: string }
	message?: string
	error?: { message: string }
	notice?: { body: string; route?: { kind: string; id?: string } }
	assistant?: {
		size: { sheet: number; sidebar: number }
		open: Record<string, true>
	}
	state?: {
		count?: number
		currentViewing?: string | null
		revision?: number
	}
}

interface Client {
	send(value: unknown): void
	waitFor(pred: (m: Message) => boolean, timeoutMs?: number): Promise<Message>
	messages(): readonly Message[]
	close(): void
}

function connect(path: string): Promise<Client> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
	const messages: Message[] = []
	const waiters: { pred: (m: Message) => boolean; resolve: (m: Message) => void }[] = []
	ws.addEventListener('message', (event) => {
		const m = JSON.parse(
			typeof event.data === 'string' ? event.data : String(event.data)
		) as Message
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
				messages: () => messages,
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

test('/agent sends a snapshot, then publishes items and status', async () => {
	const client = await connect('/agent')
	// Offline the shared session can't build, so the snapshot has empty history.
	const initial = await client.waitFor((m) => m.type === 'snapshot')
	expect(initial.history).toEqual([])
	expect(initial.status).toEqual({ state: 'idle' })

	// A prompt publishes status, admission, then an idle status with the classified error.
	client.send({ type: 'prompt', text: 'hello' })
	await client.waitFor((m) => m.type === 'status' && m.status?.state === 'thinking')
	await client.waitFor((m) => m.type === 'accepted')
	const finished = await client.waitFor(
		(m) =>
			m.type === 'status' &&
			m.status?.state === 'idle' &&
			m.error !== null &&
			typeof m.error === 'object'
	)
	expect(finished.error?.message.length).toBeGreaterThan(0)
	expect(
		client
			.messages()
			.slice(1)
			.filter((message) => ['status', 'accepted'].includes(message.type ?? ''))
			.map((message) => message.type)
	).toEqual(['status', 'accepted', 'status'])
	client.close()
})

test('keyed agent sockets publish only their app session', async () => {
	const files = await connect(`/agent/${FILES}`)
	const dictionary = await connect('/agent/justfiles.dictionary')
	const appWindow = await connect(`/app/${FILES}/connect`)
	const system = await connect('/system')
	await Promise.all([
		files.waitFor((message) => message.type === 'snapshot'),
		dictionary.waitFor((message) => message.type === 'snapshot'),
		appWindow.waitFor((message) => message.assistant !== undefined),
		system.waitFor((message) => message.type === 'commands')
	])

	files.send({ type: 'prompt', text: 'what app is this?' })
	await files.waitFor(
		(message) => message.type === 'status' && message.status?.state === 'thinking'
	)
	await files.waitFor(
		(message) => message.type === 'status' && message.status?.state === 'idle' && !!message.error
	)
	const notice = await appWindow.waitFor((message) => message.notice !== undefined)

	expect(dictionary.messages().map((message) => message.type)).toEqual(['snapshot'])
	expect(notice.notice?.route).toEqual({ kind: 'app', id: FILES })
	expect(system.messages().some((message) => message.type === 'notification')).toBe(false)
	files.close()
	dictionary.close()
	appWindow.close()
	system.close()
})

test('an app named main does not share the main agent topic', async () => {
	const main = await connect('/agent')
	const app = await connect('/agent/main')
	await Promise.all([
		main.waitFor((message) => message.type === 'snapshot'),
		app.waitFor((message) => message.type === 'snapshot')
	])

	main.send({ type: 'prompt', text: 'hello' })
	await main.waitFor((message) => message.type === 'status' && message.status?.state === 'thinking')
	await main.waitFor(
		(message) => message.type === 'status' && message.status?.state === 'idle' && !!message.error
	)

	expect(app.messages().map((message) => message.type)).toEqual(['snapshot'])
	main.close()
	app.close()
})

test('/agent returns expired for a missing activity detail', async () => {
	const client = await connect('/agent')
	await client.waitFor((message) => message.type === 'snapshot')
	client.send({ type: 'activity_detail', requestId: 'detail-request', detailId: 'missing' })
	const result = await client.waitFor(
		(message) => message.type === 'activity_detail' && message.requestId === 'detail-request'
	)
	expect(result.result).toEqual({ status: 'expired' })
	client.close()
})

test('/app socket pushes initial state and round-trips a dispatch', async () => {
	const client = await connect(`/app/${FILES}/connect`)
	const assistant = await client.waitFor((message) => message.assistant !== undefined)
	expect(assistant.assistant).toEqual({
		size: { sheet: 280, sidebar: 300 },
		open: {}
	})
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

test('/app socket persists attached-agent state and restores only saved sidebars', async () => {
	const client = await connect(`/app/${FILES}/connect`)
	await client.waitFor((message) => message.assistant !== undefined)
	client.send({
		shell: 'attached-agent',
		change: { size: { sheet: 260, sidebar: 360 }, open: true }
	})
	const changed = await client.waitFor((message) => message.assistant?.open[FILES] === true)
	expect(changed.assistant).toEqual({
		size: { sheet: 260, sidebar: 360 },
		open: { [FILES]: true }
	})
	client.close()

	const restored = await connect(`/app/${FILES}/connect`)
	expect((await restored.waitFor((message) => message.assistant !== undefined)).assistant).toEqual(
		changed.assistant
	)
	restored.send({ shell: 'attached-agent', change: { open: false } })
	const sheet = await restored.waitFor(
		(message) => message.assistant !== undefined && !message.assistant.open[FILES]
	)
	expect(sheet.assistant?.open).toEqual({})
	restored.close()
})

// A fake JustApps registry: one published app, served from an immutable release URL. The
// daemon reads the registry through the global `fetch`, so `withRegistry` patches it for
// the duration of a test and passes everything else (this test's own requests to the
// server) through to the real one.
const TASKS = 'com.example.tasks'
const RELEASE = 'https://com-example-tasks.justapps.run/v/1.0.0/'
const POINTER = 'https://com-example-tasks.justapps.run/manifest.json'
const CLASH_POINTER = 'https://justfiles-files.justapps.run/manifest.json'
// A second published app, whose release the registry SWAPS after the catalog is listed: same
// version, more access. What the listing showed is what an install must land.
const PINNED = 'com.example.pinned'
const PINNED_RELEASE = 'https://com-example-pinned.justapps.run/v/1.0.0/'
const PINNED_POINTER = 'https://com-example-pinned.justapps.run/manifest.json'
const REVIEWED = { volume: { id: 'volume', scopes: ['read'] } }
let pinnedCapabilities = REVIEWED
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
		},
		{ id: PINNED, name: 'Pinned', version: '1.0.0', manifestUrl: PINNED_POINTER },
		{ id: FILES, name: 'Files', version: '9.9.9', manifestUrl: CLASH_POINTER }
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
		if (url === PINNED_POINTER)
			return Promise.resolve(
				json(
					{ ...release, id: PINNED, name: 'Pinned', capabilities: pinnedCapabilities },
					`${PINNED_RELEASE}manifest.json`
				)
			)
		if (url === CLASH_POINTER)
			return Promise.resolve(
				json({ ...release, id: FILES, name: 'Files', version: '9.9.9' }, CLASH_POINTER)
			)
		const base = [RELEASE, PINNED_RELEASE].find((prefix) => url.startsWith(prefix))
		if (base) {
			const body = files[url.slice(base.length)]
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

test('/store lists what JustApps publishes without file manifests', async () => {
	const apps = await withRegistry(async () => {
		const res = await fetch(`http://127.0.0.1:${port}/store`)
		expect(res.status).toBe(200)
		return ((await res.json()) as { apps: Record<string, unknown>[] }).apps
	})

	expect(apps.map((app) => app.id)).toEqual([TASKS, PINNED, FILES])
	expect(apps[0]).toEqual({
		id: TASKS,
		name: 'Tasks',
		description: 'Track things',
		version: '1.0.0',
		repository: 'https://example.com/tasks',
		capabilities: release.capabilities
	})
})

const install = (path: string, init?: RequestInit): Promise<Response> =>
	fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', ...init })

// Order matters: this runs before the install test below, so a refused install is observable
// as Tasks still being absent from the kernel's catalog.
test('POST /store/:id refuses a foreign origin and a moved pointer', async () => {
	await withRegistry(async () => {
		// Loopback is reachable from any page in any browser here; only ours may install.
		const foreign = await install(`/store/${TASKS}?version=1.0.0`, {
			headers: { origin: 'https://evil.example' }
		})
		expect(foreign.status).toBe(403)

		// No version is no consent record.
		expect((await install(`/store/${TASKS}`)).status).toBe(400)

		// A version the listing does not carry was never consented to.
		const moved = await install(`/store/${TASKS}?version=0.9.0`)
		expect(moved.status).toBe(502)
		expect(await moved.text()).toContain('not what the App Store lists')

		const kernel = await getKernel()
		expect((await kernel.list()).map((app) => app.id)).not.toContain(TASKS)
	})
})

test('POST /store/:id installs a published app, and 502s an unknown one', async () => {
	await withRegistry(async () => {
		// Browse, then install — the order the tile works in, and the only one the daemon honours.
		expect((await fetch(`http://127.0.0.1:${port}/store`)).status).toBe(200)
		const res = await install(`/store/${TASKS}?version=1.0.0`)
		expect(res.status).toBe(204)

		const kernel = await getKernel()
		expect((await kernel.list()).map((app) => app.id)).toContain(TASKS)
		// Hosted: the record and the reducer land in the Volume, the GUI stays mounted.
		const installed = await kernel.app(TASKS)
		expect(installed.manifest.baseUrl).toBe(RELEASE)
		expect(new TextDecoder().decode(await installed.read('gui.js'))).toBe('GUI')

		const missing = await install('/store/no.such.app?version=1.0.0')
		expect(missing.status).toBe(502)
	})
})

// The consent bug a version string alone cannot catch: the pointer moves to a different
// release that keeps the version and asks for more. The daemon installs the entry it listed,
// so the extra scope never lands.
test('POST /store/:id installs the listed release, not the one the pointer moved to', async () => {
	await withRegistry(async () => {
		expect((await fetch(`http://127.0.0.1:${port}/store`)).status).toBe(200)
		pinnedCapabilities = { volume: { id: 'volume', scopes: ['read', 'write'] } }
		expect((await install(`/store/${PINNED}?version=1.0.0`)).status).toBe(204)

		const installed = await (await getKernel()).app(PINNED)
		expect(installed.manifest.capabilities).toEqual(REVIEWED)
	})
})

test('Settings requires the host token and rejects cross-origin requests', async () => {
	const url = new URL('/settings/readSoul', server.url)
	const cases: Record<string, string>[] = [
		{ 'content-type': 'application/json' },
		{ 'content-type': 'application/json', authorization: 'Bearer wrong' },
		{
			'content-type': 'application/json',
			authorization: 'Bearer host-test-token',
			origin: 'https://untrusted.example'
		}
	]
	for (const headers of cases) {
		const response = await fetch(url, { method: 'POST', headers, body: '{}' })
		expect(response.status).toBe(403)
	}
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: 'Bearer host-test-token' },
		body: '{}'
	})
	expect(response.status).toBe(200)
	expect(await response.json()).toMatchObject({ seeded: true })
})
