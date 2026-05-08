import { expect, test } from 'bun:test'
import { bindCapabilities } from './capabilities-bridge.js'

test('bindCapabilities enriches broker errors with capability and method', async () => {
	const capabilities = bindCapabilities(
		{
			async invoke() {
				throw { code: 'CAPABILITY_DENIED', message: 'missing grant' }
			}
		},
		[{ id: 'email', scopes: [] }]
	)

	await expect(
		(capabilities.email as { listUnread(input: unknown): Promise<unknown> }).listUnread({
			limit: 1
		})
	).rejects.toEqual({
		code: 'CAPABILITY_DENIED',
		message: 'missing grant',
		capability: 'email',
		method: 'listUnread'
	})
})

test('bindCapabilities leaves non-broker errors unchanged', async () => {
	const original = new Error('network down')
	const capabilities = bindCapabilities(
		{
			async invoke() {
				throw original
			}
		},
		[{ id: 'email', scopes: [] }]
	)

	await expect(
		(capabilities.email as { listUnread(input: unknown): Promise<unknown> }).listUnread({
			limit: 1
		})
	).rejects.toBe(original)
})
