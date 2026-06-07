// A transport-agnostic behavior contract for a remote `Capabilities`. Given a
// local backend, `makeProxy` wires serve+proxy over whatever transport and hands
// back the proxied seam plus a `dispose`. This pins the behavior the proxied seam
// must honor independent of transport, so the wire-specific cases stay separate
// from the shared ones. Not a `.test.ts` file — the concrete `*.contract.*.test.ts`
// runners call `runProxyContract`.

import { expect, test } from 'vitest'
import { CapabilityError } from './error.ts'
import { capabilityRegistry } from './registry.ts'
import type { Capabilities, Capability, CapabilityCall } from './types.ts'

const call = (capability: string, method: string, input: unknown): CapabilityCall => ({
	appId: 'app',
	capability,
	method,
	args: [input],
	scopes: []
})

const tick = () => new Promise((r) => setTimeout(r, 10))

const echo: Capability = { invoke: async (c) => c.args[0], subscribe: async () => () => {} }

// A counter stream that ticks 1, 2, 3, … every millisecond until torn down.
const clock: Capability = {
	invoke: async () => undefined,
	subscribe: async (_c, emit) => {
		let n = 0
		const id = setInterval(() => emit(++n), 1)
		return () => clearInterval(id)
	}
}

const failing: Capability = {
	invoke: async () => undefined,
	subscribe: async () => {
		throw new CapabilityError('CAPABILITY_DENIED', 'failing', 'ticks')
	}
}

export interface ProxyHarness {
	proxy: Capabilities
	dispose(): void
}

export function runProxyContract(makeProxy: (local: Capabilities) => ProxyHarness): void {
	test('invoke round-trips through the wire', async () => {
		const h = makeProxy(capabilityRegistry({ echo }))
		try {
			expect(await h.proxy.invoke(call('echo', 'm', 5))).toBe(5)
		} finally {
			h.dispose()
		}
	})

	test('concurrent calls keep their ids straight', async () => {
		const h = makeProxy(capabilityRegistry({ echo }))
		try {
			expect(
				await Promise.all([
					h.proxy.invoke(call('echo', 'm', 1)),
					h.proxy.invoke(call('echo', 'm', 2))
				])
			).toEqual([1, 2])
		} finally {
			h.dispose()
		}
	})

	test('an invoke error surfaces as a CapabilityError with code/capability/method', async () => {
		const h = makeProxy(capabilityRegistry({ echo }))
		try {
			await expect(h.proxy.invoke(call('nope', 'm', 0))).rejects.toMatchObject({
				code: 'CAPABILITY_UNAVAILABLE',
				capability: 'nope',
				method: 'm'
			})
		} finally {
			h.dispose()
		}
	})

	test('subscribe streams events in order and stops on unsub', async () => {
		const h = makeProxy(capabilityRegistry({ clock }))
		try {
			const got: number[] = []
			const unsub = await h.proxy.subscribe(call('clock', 'ticks', {}), (e) =>
				got.push(e as number)
			)
			await tick()
			unsub()
			const n = got.length
			expect(n).toBeGreaterThan(0)
			await tick()
			expect(got.length).toBe(n) // no events after unsub
			expect(got).toEqual([...Array(n)].map((_, i) => i + 1)) // ordered 1..n
		} finally {
			h.dispose()
		}
	})

	test('a subscribe whose server-side open fails rejects the caller', async () => {
		const h = makeProxy(capabilityRegistry({ failing }))
		try {
			await expect(h.proxy.subscribe(call('failing', 'ticks', {}), () => {})).rejects.toMatchObject(
				{
					code: 'CAPABILITY_DENIED',
					capability: 'failing',
					method: 'ticks'
				}
			)
		} finally {
			h.dispose()
		}
	})

	test('an unknown-capability subscribe rejects rather than silently dying', async () => {
		const h = makeProxy(capabilityRegistry({ echo }))
		try {
			await expect(h.proxy.subscribe(call('nope', 'ticks', {}), () => {})).rejects.toMatchObject({
				code: 'CAPABILITY_UNAVAILABLE'
			})
		} finally {
			h.dispose()
		}
	})
}
