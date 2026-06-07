import { expect, test } from 'vitest'
import { capabilityRegistry } from './registry.ts'
import type { Capability, CapabilityCall } from './types.ts'

const call = (
	capability: string,
	method: string,
	input: unknown,
	x?: Partial<CapabilityCall>
): CapabilityCall => ({ appId: 'app', capability, method, args: [input], scopes: [], ...x })

const echo: Capability = { invoke: async (c) => c.args[0], subscribe: async () => () => {} }

test('routes invoke to the named unit', async () => {
	const caps = capabilityRegistry({ echo })
	expect(await caps.invoke(call('echo', 'm', 42))).toBe(42)
})

test('an unknown name rejects with CAPABILITY_UNAVAILABLE', async () => {
	const caps = capabilityRegistry({ echo })
	await expect(caps.invoke(call('nope', 'm', 1))).rejects.toMatchObject({
		code: 'CAPABILITY_UNAVAILABLE',
		capability: 'nope',
		method: 'm'
	})
})

test('the fallback catches names absent from the map', async () => {
	const fb = capabilityRegistry({}, { fallback: echo })
	expect(await fb.invoke(call('anything', 'm', 7))).toBe(7)
})

test('routes subscribe to the named unit', async () => {
	let emitted: unknown
	const clock: Capability = {
		invoke: async () => undefined,
		subscribe: async (_c, emit) => {
			emit(99)
			return () => {}
		}
	}
	const caps = capabilityRegistry({ clock })
	await caps.subscribe(call('clock', 'ticks', {}), (e) => {
		emitted = e
	})
	expect(emitted).toBe(99)
})
