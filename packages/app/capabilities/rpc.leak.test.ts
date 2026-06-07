// Guards Cap'n Web's no-auto-GC footgun: a client unsubscribe must release the
// server-side subscription. Open N streams, dispose all, and assert every
// server-side `unsub` fired — otherwise the dup'd emit stub and the backend
// subscription would leak.

import { expect, test } from 'vitest'
import { capabilityRegistry } from './registry.ts'
import { transportPair } from './rpc.testpair.ts'
import { proxyCapabilitiesRpc, serveCapabilitiesRpc } from './rpc.ts'
import type { Capability, CapabilityCall } from './types.ts'

const call = (capability: string, method: string): CapabilityCall => ({
	appId: 'app',
	capability,
	method,
	args: [{}],
	scopes: []
})

const tick = () => new Promise((r) => setTimeout(r, 10))

test('disposing every subscription releases the server-side unsub', async () => {
	let live = 0
	const counting: Capability = {
		invoke: async () => undefined,
		subscribe: async () => {
			live++
			return () => {
				live--
			}
		}
	}
	const [a, b] = transportPair()
	serveCapabilitiesRpc(b, capabilityRegistry({ counting }))
	const { caps } = proxyCapabilitiesRpc(a)

	const n = 5
	const unsubs = await Promise.all(
		Array.from({ length: n }, () => caps.subscribe(call('counting', 'ticks'), () => {}))
	)
	expect(live).toBe(n) // all open server-side

	for (const u of unsubs) u()
	await tick()
	expect(live).toBe(0) // every server-side unsub fired — nothing leaked

	a.abort?.(new Error('done'))
	b.abort?.(new Error('done'))
})

test('a broken session tears down server subscriptions even without an explicit unsub', async () => {
	let live = 0
	const counting: Capability = {
		invoke: async () => undefined,
		subscribe: async () => {
			live++
			return () => {
				live--
			}
		}
	}
	const [a, b] = transportPair()
	serveCapabilitiesRpc(b, capabilityRegistry({ counting }))
	const { caps } = proxyCapabilitiesRpc(a)

	await caps.subscribe(call('counting', 'ticks'), () => {})
	expect(live).toBe(1)

	// No unsub() call — the session simply breaks. Cap'n Web disposes the exported
	// unsub stub; the attached Symbol.dispose must still run the backend teardown.
	b.abort?.(new Error('server gone'))
	await tick()
	expect(live).toBe(0)
})
