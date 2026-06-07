import {
	type Capability,
	type CapabilityCall,
	capabilityRegistry,
	serveCapabilitiesRpc,
	wsFeedTransport
} from '@justfiles/app/capabilities'
import { expect, test } from 'vitest'
import { capsProxyOverSocket } from './capabilities.client.ts'

const call = (capability: string, method: string, input: unknown): CapabilityCall => ({
	appId: 'app',
	capability,
	method,
	args: [input],
	scopes: []
})

const echo: Capability = { invoke: async (c) => c.args[0], subscribe: async () => () => {} }
const tick = () => new Promise((r) => setTimeout(r, 10))

// A minimal in-memory WebSocket-shaped duplex — just enough for the caps wire:
// addEventListener('message'|'close') + send. send() reaches the peer's message
// listeners on a microtask; close() fires both ends' close listeners.
class FakeWs {
	peer!: FakeWs
	private readonly onMessage: Array<(e: { data: string }) => void> = []
	private readonly onClose: Array<() => void> = []
	send(frame: string): void {
		queueMicrotask(() => {
			for (const cb of this.peer.onMessage) cb({ data: frame })
		})
	}
	addEventListener(type: 'message' | 'close' | 'error', cb: (e: { data: string }) => void): void {
		if (type === 'message') this.onMessage.push(cb)
		else if (type === 'close') this.onClose.push(cb as () => void)
		// 'error' is registered by the wire but never simulated here.
	}
	close(): void {
		for (const ws of [this, this.peer]) for (const cb of ws.onClose) cb()
	}
}

function fakeSocketPair(): [WebSocket, WebSocket] {
	const a = new FakeWs()
	const b = new FakeWs()
	a.peer = b
	b.peer = a
	return [a as unknown as WebSocket, b as unknown as WebSocket]
}

test('the browser wire round-trips an invoke and receives a server dirty push', async () => {
	const [clientWs, serverWs] = fakeSocketPair()

	// Server end: the same push-ws → wsFeedTransport wiring the browser uses.
	const s = wsFeedTransport(serverWs)
	serverWs.addEventListener('message', (e) => s.feed(e.data as string))
	const server = serveCapabilitiesRpc(s.transport, capabilityRegistry({ echo }))

	// Client end: the real browser helper.
	let dirtied = 0
	const proxy = capsProxyOverSocket(clientWs, () => {
		dirtied++
	})

	expect(await proxy.caps.invoke(call('echo', 'm', 5))).toBe(5)
	await expect(proxy.caps.invoke(call('nope', 'm', 0))).rejects.toMatchObject({
		code: 'CAPABILITY_UNAVAILABLE'
	})

	server.dirty('com.example.app')
	await tick()
	expect(dirtied).toBe(1)
})

test('a socket close rejects an in-flight invoke so the caller can self-heal', async () => {
	// No server wired on the peer — the invoke never gets a reply, so it stays
	// pending until the socket closes. Without close → abort it would hang forever.
	const [clientWs] = fakeSocketPair()
	const proxy = capsProxyOverSocket(clientWs, () => {})

	const pending = proxy.caps.invoke(call('echo', 'm', 1))
	clientWs.close()

	await expect(pending).rejects.toMatchObject({ code: 'CAPABILITY_OFFLINE' })
})
