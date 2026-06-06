import {
	type Capability,
	type CapabilityCall,
	capabilityRegistry,
	proxyCapabilities,
	serveCapabilities
} from '@justfiles/app/capabilities'
import { expect, test } from 'vitest'
import { wsChannel } from './capabilities.client.ts'

const call = (capability: string, method: string, input: unknown): CapabilityCall => ({
	appId: 'app',
	capability,
	method,
	input,
	scopes: []
})

const echo: Capability = { invoke: async (c) => c.input, subscribe: async () => () => {} }

// A minimal in-memory WebSocket-shaped duplex — just enough for wsChannel:
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
	addEventListener(type: 'message' | 'close', cb: (e: { data: string }) => void): void {
		if (type === 'message') this.onMessage.push(cb)
		else this.onClose.push(cb as () => void)
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

test('wsChannel adapts a WebSocket so serve + proxy round-trip an invoke', async () => {
	const [clientWs, serverWs] = fakeSocketPair()
	serveCapabilities(wsChannel(serverWs), capabilityRegistry({ echo }))
	const proxy = proxyCapabilities(async () => wsChannel(clientWs))

	expect(await proxy.invoke(call('echo', 'm', 5))).toBe(5)
	await expect(proxy.invoke(call('nope', 'm', 0))).rejects.toMatchObject({
		code: 'CAPABILITY_UNAVAILABLE'
	})
})
