// The server→client `dirty` push: the browser exports a `CapsClient` as its local
// main, and the server pushes nudges back over the SAME session — replacing the
// old out-of-band `{type:'dirty'}` JSON frame. This is the new mechanism the
// server cutover (frieren.app.ts) relies on.

import { expect, test } from 'vitest'
import { transportPair } from './rpc.testpair.ts'
import { proxyCapabilitiesRpc, serveCapabilitiesRpc } from './rpc.ts'
import type { Capabilities } from './types.ts'

const local: Capabilities = { invoke: async (c) => c.args[0], subscribe: async () => () => {} }

const tick = () => new Promise((r) => setTimeout(r, 10))

test('the server pushes dirty back to the client over the same session', async () => {
	const [a, b] = transportPair()
	const server = serveCapabilitiesRpc(b, local)
	const seen: string[] = []
	const { caps } = proxyCapabilitiesRpc(a, { dirty: (appId) => void seen.push(appId) })

	// client→server invoke still works over the same session
	expect(
		await caps.invoke({ appId: 'app', capability: 'x', method: 'm', args: [1], scopes: [] })
	).toBe(1)

	// server→client push
	server.dirty('com.example.app')
	await tick()
	expect(seen).toEqual(['com.example.app'])

	a.abort?.(new Error('done'))
	b.abort?.(new Error('done'))
})
