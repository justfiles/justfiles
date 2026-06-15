import { expect, test } from 'vitest'
import type { CapabilityCall } from '../types.ts'
import { notifyHost } from './host.ts'
import type { Notification } from './types.ts'

// The `notify` host in isolation: an app emits a notify command and the channel
// receives the notification with the kernel-stamped `source`. The trust boundary
// is the point — `source` comes from the trusted `appId` on the call, never from
// the app-supplied payload.

const call = (args: unknown[], x?: Partial<CapabilityCall>): CapabilityCall => ({
	appId: 'app.example',
	capability: 'notify',
	method: 'notify',
	args,
	scopes: [],
	...x
})

test('stamps source from the kernel-attached appId', async () => {
	const seen: Notification[] = []
	const cap = notifyHost((n) => seen.push(n))
	await cap.invoke(call([{ id: 'n1', kind: 'info', title: 'Done', body: 'ok' }]))
	expect(seen).toEqual([
		{ id: 'n1', kind: 'info', title: 'Done', body: 'ok', source: 'app.example' }
	])
})

test('an app cannot spoof another source', async () => {
	const seen: Notification[] = []
	const cap = notifyHost((n) => seen.push(n))
	// Even if the payload carries a `source`, the host overrides it with the appId.
	await cap.invoke(
		call([{ id: 'n2', source: 'agent', kind: 'info', title: 't', body: 'b' }], {
			appId: 'app.evil'
		})
	)
	expect(seen[0]?.source).toBe('app.evil')
})
