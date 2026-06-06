import { expect, test } from 'vitest'
import { type Channel, proxyCapabilities, serveCapabilities } from './proxy.ts'
import { capabilityRegistry } from './registry.ts'
import type { Capability, CapabilityCall } from './types.ts'

const call = (
	capability: string,
	method: string,
	input: unknown,
	x?: Partial<CapabilityCall>
): CapabilityCall => ({ appId: 'app', capability, method, input, scopes: [], ...x })

// An in-memory Channel pair — the only "transport" the proxy tests need.
function pair(): [Channel, Channel] {
	const e: { rx?: (f: string) => void; close?: () => void }[] = [{}, {}]
	const mk = (me: 0 | 1): Channel => ({
		send: (f) => queueMicrotask(() => e[me ^ 1].rx?.(f)),
		onMessage: (cb) => {
			e[me].rx = cb
		},
		onClose: (cb) => {
			e[me].close = cb
		}
	})
	return [mk(0), mk(1)]
}

const echo: Capability = { invoke: async (c) => c.input, subscribe: async () => () => {} }

const tick = () => new Promise((r) => setTimeout(r, 10))

// A counter stream that ticks 1, 2, 3, … every millisecond until torn down.
const clock: Capability = {
	invoke: async () => undefined,
	subscribe: async (_c, emit) => {
		let n = 0
		const id = setInterval(() => emit(++n), 1)
		return () => clearInterval(id)
	}
}

test('invoke round-trips through a channel', async () => {
	const [a, b] = pair()
	serveCapabilities(b, capabilityRegistry({ echo }))
	const proxy = proxyCapabilities(async () => a)
	expect(await proxy.invoke(call('echo', 'm', 5))).toBe(5)
})

test('concurrent calls keep their ids straight', async () => {
	const [a, b] = pair()
	serveCapabilities(b, capabilityRegistry({ echo }))
	const proxy = proxyCapabilities(async () => a)
	expect(
		await Promise.all([proxy.invoke(call('echo', 'm', 1)), proxy.invoke(call('echo', 'm', 2))])
	).toEqual([1, 2])
})

test('an error frame surfaces as a CapabilityError', async () => {
	const [a, b] = pair()
	serveCapabilities(b, capabilityRegistry({ echo }))
	const proxy = proxyCapabilities(async () => a)
	await expect(proxy.invoke(call('nope', 'm', 0))).rejects.toMatchObject({
		code: 'CAPABILITY_UNAVAILABLE',
		capability: 'nope',
		method: 'm'
	})
})

test('a channel close rejects all pending and the next call reopens', async () => {
	let opens = 0
	let live: { close?: () => void } = {}
	const proxy = proxyCapabilities(async () => {
		opens++
		const [a, b] = pair()
		live = a as unknown as { close?: () => void }
		// capture the close hook the proxy registers
		const realOnClose = a.onClose
		a.onClose = (cb) => {
			live.close = cb
			realOnClose.call(a, cb)
		}
		serveCapabilities(b, capabilityRegistry({ echo }))
		return a
	})

	expect(await proxy.invoke(call('echo', 'm', 1))).toBe(1)
	expect(opens).toBe(1)
	live.close?.() // simulate a drop
	expect(await proxy.invoke(call('echo', 'm', 2))).toBe(2)
	expect(opens).toBe(2) // reopened
})

test('a failed open does not wedge the proxy; the next call retries', async () => {
	let opens = 0
	const proxy = proxyCapabilities(async () => {
		opens++
		if (opens === 1) throw new Error('handshake failed')
		const [a, b] = pair()
		serveCapabilities(b, capabilityRegistry({ echo }))
		return a
	})
	await expect(proxy.invoke(call('echo', 'm', 1))).rejects.toThrow('handshake failed')
	expect(await proxy.invoke(call('echo', 'm', 2))).toBe(2) // reopened, not wedged
	expect(opens).toBe(2)
})

test('subscribe streams events in order and stops on unsub', async () => {
	const [a, b] = pair()
	serveCapabilities(b, capabilityRegistry({ clock }))
	const proxy = proxyCapabilities(async () => a)

	const got: number[] = []
	const unsub = await proxy.subscribe(call('clock', 'ticks', {}), (e) => got.push(e as number))
	await tick()
	unsub()
	const n = got.length
	expect(n).toBeGreaterThan(0)
	await tick()
	expect(got.length).toBe(n) // no events after unsub
	expect(got).toEqual([...Array(n)].map((_, i) => i + 1)) // ordered 1..n
})

test('a channel close stops every server-side subscription', async () => {
	let live: (() => void) | undefined
	const clockSubs: number[] = []
	const counting: Capability = {
		invoke: async () => undefined,
		subscribe: async (_c, emit) => {
			const id = setInterval(() => emit(1), 1)
			clockSubs.push(id as unknown as number)
			return () => clearInterval(id)
		}
	}
	const proxy = proxyCapabilities(async () => {
		const [a, b] = pair()
		const realOnClose = b.onClose
		b.onClose = (cb) => {
			live = cb
			realOnClose.call(b, cb)
		}
		serveCapabilities(b, capabilityRegistry({ counting }))
		return a
	})

	const got: number[] = []
	await proxy.subscribe(call('counting', 'ticks', {}), (e) => got.push(e as number))
	await tick()
	expect(got.length).toBeGreaterThan(0)
	live?.() // server channel closes — every open sub must be torn down
	const n = got.length
	await tick()
	expect(got.length).toBe(n) // no further events delivered
})
