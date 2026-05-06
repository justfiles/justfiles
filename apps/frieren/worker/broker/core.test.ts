import { describe, expect, test } from 'bun:test'
import type {
	AuditEvent,
	CalendarEventDTO,
	CalendarProviderAdapter,
	EmailDetailDTO,
	EmailDTO,
	EmailProviderAdapter,
	SandboxContext,
	VolumeProviderAdapter
} from './contracts.ts'
import { checkGrant, createCapabilities } from './core.ts'

const ctx = (overrides: Partial<SandboxContext> = {}): SandboxContext => ({
	userId: 'u1',
	appId: 'today',
	appVersion: '1.0.0',
	grants: [],
	...overrides
})

const sampleEmail: EmailDTO = {
	id: 'e1',
	accountId: 'work',
	source: 'fastmail',
	from: { name: 'Alice', email: 'alice@example.com' },
	subject: 'hello',
	receivedAt: 1_700_000_000_000,
	preview: 'hi there'
}

const sampleDetail: EmailDetailDTO = {
	...sampleEmail,
	to: [{ email: 'me@example.com' }],
	text: 'full body — must not be persisted by apps'
}

const sampleEvent: CalendarEventDTO = {
	id: 'ev1',
	accountId: 'me',
	source: 'icloud-calendar',
	title: 'Standup',
	startAt: 1_700_000_000_000,
	endAt: 1_700_001_800_000
}

function fakeEmail(): EmailProviderAdapter & { calls: string[] } {
	const calls: string[] = []
	return {
		calls,
		async listUnread() {
			calls.push('listUnread')
			return [sampleEmail]
		},
		async readDetail() {
			calls.push('readDetail')
			return sampleDetail
		},
		async markRead() {
			calls.push('markRead')
		}
	}
}

function fakeCalendar(): CalendarProviderAdapter {
	return {
		async listToday() {
			return [sampleEvent]
		}
	}
}

function fakeVolume(): VolumeProviderAdapter {
	const files = new Map<string, Uint8Array>()
	return {
		async readFile({ path }) {
			const v = files.get(path)
			if (!v) throw new Error(`missing ${path}`)
			return v
		},
		async writeFile({ path, data }) {
			files.set(path, data)
		}
	}
}

describe('checkGrant', () => {
	test('denies when no matching grant exists', () => {
		const result = checkGrant(ctx(), 'email.read.unread', undefined)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('CAPABILITY_DENIED')
	})

	test('grants without accountId match any account', () => {
		const c = ctx({ grants: [{ name: 'email.read.unread' }] })
		expect(checkGrant(c, 'email.read.unread', 'work').ok).toBe(true)
		expect(checkGrant(c, 'email.read.unread', undefined).ok).toBe(true)
	})

	test('grants with accountId require exact match', () => {
		const c = ctx({ grants: [{ name: 'email.read.unread', accountId: 'work' }] })
		expect(checkGrant(c, 'email.read.unread', 'work').ok).toBe(true)
		const denied = checkGrant(c, 'email.read.unread', 'personal')
		expect(denied.ok).toBe(false)
	})
})

describe('createCapabilities', () => {
	test('email.listUnread is denied without grant and no provider call is made', async () => {
		const adapter = fakeEmail()
		const caps = createCapabilities(ctx(), { email: new Map([['work', adapter]]) })
		const result = await caps.email.listUnread({ accountId: 'work' })
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('CAPABILITY_DENIED')
		expect(adapter.calls).toEqual([])
	})

	test('email.listUnread returns normalized DTOs when granted', async () => {
		const adapter = fakeEmail()
		const caps = createCapabilities(
			ctx({ grants: [{ name: 'email.read.unread', accountId: 'work' }] }),
			{ email: new Map([['work', adapter]]) }
		)
		const result = await caps.email.listUnread({ accountId: 'work' })
		expect(result.ok).toBe(true)
		if (result.ok) expect(result.value).toEqual([sampleEmail])
	})

	test('email.readDetail returns full DTO including text body', async () => {
		const adapter = fakeEmail()
		const caps = createCapabilities(ctx({ grants: [{ name: 'email.read.detail' }] }), {
			email: new Map([['work', adapter]])
		})
		const result = await caps.email.readDetail({
			id: 'e1',
			accountId: 'work',
			purpose: 'briefing-detail'
		})
		expect(result.ok).toBe(true)
		if (result.ok) expect(result.value.text).toBe(sampleDetail.text)
	})

	test('email.markRead requires the markRead grant specifically', async () => {
		const adapter = fakeEmail()
		const caps = createCapabilities(ctx({ grants: [{ name: 'email.read.unread' }] }), {
			email: new Map([['work', adapter]])
		})
		const result = await caps.email.markRead({ id: 'e1', accountId: 'work' })
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('CAPABILITY_DENIED')
	})

	test('email.markRead succeeds with the right grant', async () => {
		const adapter = fakeEmail()
		const caps = createCapabilities(
			ctx({ grants: [{ name: 'email.markRead', accountId: 'work' }] }),
			{ email: new Map([['work', adapter]]) }
		)
		const result = await caps.email.markRead({ id: 'e1', accountId: 'work' })
		expect(result.ok).toBe(true)
		expect(adapter.calls).toEqual(['markRead'])
	})

	test('grant scoped to one account does not leak to another', async () => {
		const work = fakeEmail()
		const personal = fakeEmail()
		const caps = createCapabilities(
			ctx({ grants: [{ name: 'email.read.unread', accountId: 'work' }] }),
			{
				email: new Map([
					['work', work],
					['personal', personal]
				])
			}
		)
		const ok = await caps.email.listUnread({ accountId: 'work' })
		const denied = await caps.email.listUnread({ accountId: 'personal' })
		expect(ok.ok).toBe(true)
		expect(denied.ok).toBe(false)
		expect(personal.calls).toEqual([])
	})

	test('missing email account returns ACCOUNT_NOT_CONFIGURED', async () => {
		const caps = createCapabilities(ctx({ grants: [{ name: 'email.read.unread' }] }), {
			email: new Map()
		})
		const result = await caps.email.listUnread({})
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('ACCOUNT_NOT_CONFIGURED')
	})

	test('provider failure surfaces as PROVIDER_ERROR', async () => {
		const adapter: EmailProviderAdapter = {
			async listUnread() {
				throw new Error('upstream 503')
			},
			async readDetail() {
				throw new Error('nope')
			},
			async markRead() {
				throw new Error('nope')
			}
		}
		const caps = createCapabilities(ctx({ grants: [{ name: 'email.read.unread' }] }), {
			email: new Map([['work', adapter]])
		})
		const result = await caps.email.listUnread({ accountId: 'work' })
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error.code).toBe('PROVIDER_ERROR')
			expect(result.error.message).toContain('upstream 503')
		}
	})

	test('calendar.listToday respects grant', async () => {
		const adapter = fakeCalendar()
		const caps = createCapabilities(ctx({ grants: [{ name: 'calendar.read.today' }] }), {
			calendar: new Map([['me', adapter]])
		})
		const result = await caps.calendar.listToday({ timezone: 'UTC' })
		expect(result.ok).toBe(true)
		if (result.ok) expect(result.value).toEqual([sampleEvent])
	})

	test('volume.read is denied without grant', async () => {
		const caps = createCapabilities(ctx(), { volume: fakeVolume() })
		const result = await caps.volume.readFile({ path: '/x' })
		expect(result.ok).toBe(false)
	})

	test('volume.write/read round-trips when granted', async () => {
		const caps = createCapabilities(
			ctx({ grants: [{ name: 'volume.read' }, { name: 'volume.write' }] }),
			{ volume: fakeVolume() }
		)
		const data = new Uint8Array([1, 2, 3])
		const w = await caps.volume.writeFile({ path: '/x', data })
		expect(w.ok).toBe(true)
		const r = await caps.volume.readFile({ path: '/x' })
		expect(r.ok).toBe(true)
		if (r.ok) expect(r.value.data).toEqual(data)
	})

	test('audit hook is invoked for both success and denial', async () => {
		const events: AuditEvent[] = []
		const adapter = fakeEmail()
		const caps = createCapabilities(
			ctx({ grants: [{ name: 'email.read.unread' }] }),
			{ email: new Map([['work', adapter]]) },
			{ audit: (e) => void events.push(e), now: () => 42 }
		)
		await caps.email.listUnread({ accountId: 'work' })
		await caps.email.markRead({ id: 'e1', accountId: 'work' })
		expect(events).toHaveLength(2)
		expect(events[0]).toMatchObject({ capability: 'email.read.unread', ok: true, ts: 42 })
		expect(events[1]).toMatchObject({
			capability: 'email.markRead',
			ok: false,
			errorCode: 'CAPABILITY_DENIED'
		})
	})
})
