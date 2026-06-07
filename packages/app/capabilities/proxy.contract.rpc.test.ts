// The shared behavior contract (`runProxyContract`) run against the Cap'n Web wire.
// Then the cases the old JSON wire could never do: Uint8Array and bigint cross by
// value.

import { expect, test } from 'vitest'
import { runProxyContract } from './proxy.contract.ts'
import { transportPair } from './rpc.testpair.ts'
import { proxyCapabilitiesRpc, serveCapabilitiesRpc } from './rpc.ts'
import type { Capabilities, CapabilityCall } from './types.ts'

runProxyContract((local) => {
	const [a, b] = transportPair()
	serveCapabilitiesRpc(b, local)
	const { caps } = proxyCapabilitiesRpc(a)
	return {
		proxy: caps,
		dispose: () => {
			a.abort?.(new Error('done'))
			b.abort?.(new Error('done'))
		}
	}
})

const call = (input: unknown): CapabilityCall => ({
	appId: 'app',
	capability: 'echo',
	method: 'm',
	args: [input],
	scopes: []
})

test('Uint8Array and bigint cross the wire by value (impossible on the JSON wire)', async () => {
	const echo: Capabilities = {
		invoke: async (c) => c.args[0],
		subscribe: async () => () => {}
	}
	const [a, b] = transportPair()
	serveCapabilitiesRpc(b, echo)
	const { caps } = proxyCapabilitiesRpc(a)

	const bytes = (await caps.invoke(call(new Uint8Array([1, 2, 3])))) as Uint8Array
	expect(Array.from(bytes)).toEqual([1, 2, 3])

	expect(await caps.invoke(call(7n))).toBe(7n)

	a.abort?.(new Error('done'))
	b.abort?.(new Error('done'))
})
