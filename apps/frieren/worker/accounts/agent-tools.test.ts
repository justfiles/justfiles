import { type Capability, type CapabilityCall, CapabilityError } from '@justfiles/app/capabilities'
import { describe, expect, test } from 'vitest'
import { accountTools } from './agent-tools.ts'

// Stub the use-facet capabilities the agent reaches through. Each records the call
// it received so we can assert the tool builds the right CapabilityCall, and returns
// canned data so we can assert the rendering.
function stub(handler: (call: CapabilityCall) => unknown): {
	cap: Capability
	calls: CapabilityCall[]
} {
	const calls: CapabilityCall[] = []
	return {
		calls,
		cap: {
			invoke: async (call) => {
				calls.push(call)
				return handler(call)
			},
			subscribe: async () => () => {}
		}
	}
}

const unavailable: Capability = {
	invoke: async (call) => {
		throw new CapabilityError('CAPABILITY_UNAVAILABLE', call.capability)
	},
	subscribe: async () => () => {}
}

function build(over: { email?: Capability; calendar?: Capability } = {}) {
	const [email, calendar] = accountTools({
		email: over.email ?? unavailable,
		calendar: over.calendar ?? unavailable,
		getTimezone: () => 'UTC'
	})
	return { email, calendar }
}

const textOf = (r: { content: readonly unknown[] }): string =>
	(r.content[0] as { text?: string } | undefined)?.text ?? ''

describe('accountTools email', () => {
	test('list invokes listUnread and renders one line per message', async () => {
		const e = stub(() => [
			{
				id: 'm1',
				from: 'a@x.com',
				subject: 'Hi',
				receivedAt: 0,
				unread: true,
				accountId: 'fastmail'
			}
		])
		const { email } = build({ email: e.cap })
		const out = await email.execute('1', { action: 'list', limit: 5 } as never)
		expect(e.calls[0]).toMatchObject({ capability: 'email', method: 'listUnread' })
		expect(e.calls[0]?.args[0]).toMatchObject({ limit: 5 })
		expect(textOf(out)).toContain('m1')
		expect(textOf(out)).toContain('Hi')
	})

	test('read targets readDetail with a summarization purpose', async () => {
		const e = stub(() => ({
			id: 'm1',
			from: 'a@x.com',
			subject: 'Hi',
			receivedAt: 0,
			unread: false,
			bodyText: 'Body here'
		}))
		const { email } = build({ email: e.cap })
		const out = await email.execute('1', {
			action: 'read',
			id: 'm1',
			accountId: 'fastmail'
		} as never)
		expect(e.calls[0]).toMatchObject({ capability: 'email', method: 'readDetail' })
		expect(e.calls[0]?.args[0]).toMatchObject({
			id: 'm1',
			accountId: 'fastmail',
			purpose: 'summarization'
		})
		expect(textOf(out)).toContain('Body here')
	})

	test('mark-read targets markRead; missing id is reported', async () => {
		const e = stub(() => ({ success: true }))
		const { email } = build({ email: e.cap })
		expect(textOf(await email.execute('1', { action: 'mark-read', id: 'm1' } as never))).toContain(
			'marked m1'
		)
		expect(e.calls[0]).toMatchObject({ method: 'markRead' })
		expect(textOf(await email.execute('2', { action: 'read' } as never))).toContain(
			'missing required id'
		)
	})

	test('an unconnected capability becomes guidance, not a thrown error', async () => {
		const { email } = build()
		expect(textOf(await email.execute('1', { action: 'list' } as never))).toContain(
			'No email account is connected'
		)
	})
})

describe('accountTools calendar', () => {
	test('listToday is invoked with the resolved timezone and rendered', async () => {
		const c = stub(() => [
			{
				id: 'e1',
				title: 'Standup',
				startsAt: 0,
				endsAt: 1_800_000,
				location: 'Zoom',
				accountId: 'icloud'
			}
		])
		const { calendar } = build({ calendar: c.cap })
		const out = await calendar.execute('1', {} as never)
		expect(c.calls[0]).toMatchObject({ capability: 'calendar', method: 'listToday' })
		expect(c.calls[0]?.args[0]).toMatchObject({ timezone: 'UTC' })
		expect(textOf(out)).toContain('Standup')
		expect(textOf(out)).toContain('Zoom')
	})

	test('no calendar account becomes guidance', async () => {
		const { calendar } = build()
		expect(textOf(await calendar.execute('1', {} as never))).toContain(
			'No calendar account is connected'
		)
	})
})
