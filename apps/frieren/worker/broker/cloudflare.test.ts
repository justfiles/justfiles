import { describe, expect, test } from 'bun:test'
import { flattenCapabilities } from './cloudflare.ts'
import type { EmailProviderAdapter, SandboxContext } from './contracts.ts'
import { createCapabilities } from './core.ts'

const ctx: SandboxContext = {
	userId: 'u1',
	appId: 'today',
	appVersion: '1.0.0',
	grants: [{ name: 'email.read.unread' }, { name: 'email.markRead' }]
}

const adapter: EmailProviderAdapter = {
	async listUnread() {
		return [
			{
				id: 'e1',
				accountId: 'work',
				source: 'fastmail',
				from: { email: 'a@b' },
				subject: 's',
				receivedAt: 0,
				preview: ''
			}
		]
	},
	async readDetail() {
		throw new Error('unused')
	},
	async markRead() {}
}

describe('flattenCapabilities', () => {
	test('flat methods delegate to nested capabilities and preserve grant checks', async () => {
		const caps = createCapabilities(ctx, { email: new Map([['work', adapter]]) })
		const flat = flattenCapabilities(caps)
		const list = await flat.emailListUnread({ accountId: 'work' })
		expect(list.ok).toBe(true)
		const mark = await flat.emailMarkRead({ id: 'e1', accountId: 'work' })
		expect(mark.ok).toBe(true)
	})

	test('flat methods surface CAPABILITY_DENIED for ungranted capabilities', async () => {
		const caps = createCapabilities({ ...ctx, grants: [] }, { email: new Map([['work', adapter]]) })
		const flat = flattenCapabilities(caps)
		const result = await flat.emailListUnread({ accountId: 'work' })
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('CAPABILITY_DENIED')
	})
})
