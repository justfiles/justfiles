import {
	type Capability,
	type CapabilityCall,
	capabilityRegistry,
	serveCapabilitiesRpc,
	wsFeedTransport
} from '@justfiles/app/capabilities'
import type { Kernel } from '@justfiles/app/runtime'
import type { Volume } from '@justfiles/fs'
import { afterEach, expect, test, vi } from 'vitest'
import { notificationStore } from '../notifications/store.ts'
import {
	capsProxyOverSocket,
	clientCapabilities,
	resetCapabilitySocket
} from './capabilities.client.ts'

const call = (capability: string, method: string, input: unknown): CapabilityCall => ({
	appId: 'app',
	capability,
	method,
	args: [input],
	scopes: []
})

const echo: Capability = { invoke: async (c) => c.args[0], subscribe: async () => () => {} }

afterEach(() => {
	resetCapabilitySocket()
	vi.unstubAllGlobals()
})

// A minimal in-memory WebSocket-shaped duplex — just enough for the caps wire:
// addEventListener('message'|'close') + send. send() reaches the peer's message
// listeners on a microtask; close() fires both ends' close listeners.
class FakeWs {
	peer!: FakeWs
	readyState = 1
	private readonly onOpen: Array<() => void> = []
	private readonly onMessage: Array<(e: { data: string }) => void> = []
	private readonly onClose: Array<() => void> = []
	send(frame: string): void {
		queueMicrotask(() => {
			for (const cb of this.peer.onMessage) cb({ data: frame })
		})
	}
	addEventListener(
		type: 'message' | 'close' | 'error' | 'open',
		cb: (e: { data: string }) => void
	): void {
		if (type === 'message') this.onMessage.push(cb)
		else if (type === 'close') this.onClose.push(cb as () => void)
		else if (type === 'open') this.onOpen.push(cb as () => void)
		// 'error' is registered by the wire but never simulated here.
	}
	close(): void {
		for (const ws of [this, this.peer]) {
			ws.readyState = 3
			for (const cb of ws.onClose) cb()
		}
	}
	open(): void {
		for (const cb of this.onOpen) cb()
	}
}

function fakeSocketPair(): [WebSocket, WebSocket] {
	const a = new FakeWs()
	const b = new FakeWs()
	a.peer = b
	b.peer = a
	return [a as unknown as WebSocket, b as unknown as WebSocket]
}

test('the browser wire round-trips an invoke over the caps session', async () => {
	const [clientWs, serverWs] = fakeSocketPair()

	// Server end: the same push-ws → wsFeedTransport wiring the browser uses.
	const s = wsFeedTransport(serverWs)
	serverWs.addEventListener('message', (e) => s.feed(e.data as string))
	serveCapabilitiesRpc(s.transport, capabilityRegistry({ echo }))

	// Client end: the real browser helper.
	const proxy = capsProxyOverSocket(clientWs)

	expect(await proxy.caps.invoke(call('echo', 'm', 5))).toBe(5)
	await expect(proxy.caps.invoke(call('nope', 'm', 0))).rejects.toMatchObject({
		code: 'CAPABILITY_UNAVAILABLE'
	})
})

test('a socket close rejects an in-flight invoke so the caller can self-heal', async () => {
	// No server wired on the peer — the invoke never gets a reply, so it stays
	// pending until the socket closes. Without close → abort it would hang forever.
	const [clientWs] = fakeSocketPair()
	const proxy = capsProxyOverSocket(clientWs)

	const pending = proxy.caps.invoke(call('echo', 'm', 1))
	clientWs.close()

	await expect(pending).rejects.toMatchObject({ code: 'CAPABILITY_OFFLINE' })
})

test.each([
	'runAgent',
	'generateText'
])('a lost %s reply preserves the method’s retry policy', async (method) => {
	let connections = 0
	const executed: unknown[] = []
	vi.stubGlobal('navigator', { onLine: true })
	vi.stubGlobal('window', { location: { protocol: 'https:', host: 'example.com' } })
	vi.stubGlobal(
		'WebSocket',
		class extends FakeWs {
			static OPEN = 1
			constructor() {
				super()
				const connection = ++connections
				this.peer = new FakeWs()
				this.peer.peer = this
				const server = this.peer as unknown as WebSocket
				const { transport, feed } = wsFeedTransport(server)
				server.addEventListener('message', (event) => feed(event.data as string))
				serveCapabilitiesRpc(transport, {
					invoke: async (call) => {
						executed.push(call.args[0])
						if (connection === 1) server.close()
						return { text: 'finished' }
					},
					subscribe: async () => () => {}
				})
				queueMicrotask(() => this.open())
			}
		}
	)
	const caps = clientCapabilities(
		undefined as unknown as Volume,
		async () => 'token'
	)(undefined as unknown as Kernel)
	const input = { requestId: 'one', prompt: 'write a report' }
	const work = caps.invoke(call('ai', method, input))
	if (method === 'runAgent') {
		await expect(work).rejects.toMatchObject({ code: 'CAPABILITY_OFFLINE' })
		expect(executed).toEqual([input])
		expect(connections).toBe(1)
		await expect(caps.invoke(call('ai', method, { ...input, requestId: 'two' }))).resolves.toEqual({
			text: 'finished'
		})
		expect(executed).toEqual([input, { ...input, requestId: 'two' }])
	} else {
		await expect(work).resolves.toEqual({ text: 'finished' })
		expect(executed).toEqual([input, input])
	}
	expect(connections).toBe(2)
})

test('reader opens web URLs in the browser host', async () => {
	const open = vi.fn()
	vi.stubGlobal('window', { open })
	const caps = clientCapabilities(
		undefined as unknown as Volume,
		async () => null
	)(undefined as unknown as Kernel)

	await expect(
		caps.invoke(call('reader', 'open', { url: 'https://example.com/article' }))
	).resolves.toBeUndefined()
	expect(open).toHaveBeenCalledWith('https://example.com/article', '_blank', 'noopener,noreferrer')
	await expect(
		caps.invoke(call('reader', 'open', { url: 'file:///etc/passwd' }))
	).rejects.toMatchObject({
		code: 'CAPABILITY_INVALID_INPUT',
		capability: 'reader',
		method: 'open'
	})
})

// notify runs locally on the browser kernel (no server round-trip). The host stamps
// `source = appId` from the trusted call, then the frieren channel writes to the one
// notification store and defaults a click back to the emitting app. fs/kernel are
// never touched by a notify invoke, so stubs suffice.
test('an app notify is stamped with the trusted appId and routes back to that app', async () => {
	notificationStore.clear()
	const caps = clientCapabilities(
		undefined as unknown as Volume,
		async () => null
	)(undefined as unknown as Kernel)
	await caps.invoke({
		appId: 'app.example',
		capability: 'notify',
		method: 'notify',
		// The payload carries no `source` — the host supplies it from the appId.
		args: [{ id: 'n1', kind: 'info', title: 'Notes', body: 'Saved.' }],
		scopes: []
	})
	const active = notificationStore.snapshot().active
	expect(active?.notification.source).toBe('app.example')
	expect(active?.notification.route).toEqual({ kind: 'app', id: 'app.example' })
	notificationStore.clear()
})

test('settings, accounts and usage have no local app capability', async () => {
	const caps = clientCapabilities(
		undefined as unknown as Volume,
		async () => null
	)(undefined as unknown as Kernel)
	for (const gone of ['settings', 'accounts', 'usage']) {
		await expect(caps.invoke(call(gone, 'host.user', {}))).rejects.toMatchObject({
			code: 'CAPABILITY_OFFLINE'
		})
	}
})
