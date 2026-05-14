import type { Volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { createFastmailCommand } from './commands.ts'
import type { EmailDetails, EmailSummary, JmapClient, SendInput } from './jmap.ts'

interface Recorded {
	listed: Array<{ limit: number; unread?: boolean }>
	read: string[]
	sent: SendInput[]
	marked: string[]
}

function fakeClient(overrides: Partial<JmapClient> = {}): { client: JmapClient; rec: Recorded } {
	const rec: Recorded = { listed: [], read: [], sent: [], marked: [] }
	const client: JmapClient = {
		async list(opts) {
			rec.listed.push(opts)
			return overrides.list ? overrides.list(opts) : []
		},
		async read(id) {
			rec.read.push(id)
			if (overrides.read) return overrides.read(id)
			throw new Error('no read override')
		},
		async send(input) {
			rec.sent.push(input)
			return overrides.send ? overrides.send(input) : { id: 'email-1' }
		},
		async markRead(id) {
			rec.marked.push(id)
			if (overrides.markRead) return overrides.markRead(id)
		}
	}
	return { client, rec }
}

const ctx = { vol: undefined as unknown as Volume }

describe('fastmail command', () => {
	test('with no args prints help with subcommands', async () => {
		const { client } = fakeClient()
		const cmd = createFastmailCommand(client)
		const res = await cmd.run([], ctx)
		expect(res.exitCode).toBe(0)
		expect(res.stdout).toContain('list')
		expect(res.stdout).toContain('read')
		expect(res.stdout).toContain('send')
	})

	test('list calls jmap.list and renders summaries', async () => {
		const summary: EmailSummary = {
			id: 'e1',
			subject: 'Hi',
			from: [{ name: 'Bob', email: 'bob@x.com' }],
			receivedAt: '2026-05-04T10:00:00Z',
			preview: 'hello there'
		}
		const { client, rec } = fakeClient({
			async list() {
				return [summary]
			}
		})
		const cmd = createFastmailCommand(client)
		const res = await cmd.run(['list'], ctx)
		expect(res.exitCode).toBe(0)
		expect(rec.listed).toEqual([{ limit: 20, unread: false }])
		expect(res.stdout).toContain('e1')
		expect(res.stdout).toContain('Hi')
		expect(res.stdout).toContain('bob@x.com')
	})

	test('list with --limit forwards', async () => {
		const { client, rec } = fakeClient({
			async list() {
				return []
			}
		})
		const cmd = createFastmailCommand(client)
		await cmd.run(['list', '--limit', '5'], ctx)
		expect(rec.listed).toEqual([{ limit: 5, unread: false }])
	})

	test('list with --unread forwards', async () => {
		const { client, rec } = fakeClient({
			async list() {
				return []
			}
		})
		const cmd = createFastmailCommand(client)
		await cmd.run(['list', '--unread'], ctx)
		expect(rec.listed).toEqual([{ limit: 20, unread: true }])
	})

	test('mark-read calls jmap.markRead', async () => {
		const { client, rec } = fakeClient()
		const cmd = createFastmailCommand(client)
		const res = await cmd.run(['mark-read', 'e1'], ctx)
		expect(res.exitCode).toBe(0)
		expect(rec.marked).toEqual(['e1'])
		expect(res.stdout).toContain('e1')
	})

	test('mark-read without id is a usage error', async () => {
		const { client } = fakeClient()
		const cmd = createFastmailCommand(client)
		const res = await cmd.run(['mark-read'], ctx)
		expect(res.exitCode).not.toBe(0)
		expect(res.stderr).toContain('id')
	})

	test('read fetches and prints an email', async () => {
		const details: EmailDetails = {
			id: 'e1',
			subject: 'Subject',
			from: [{ name: null, email: 'a@x.com' }],
			to: [{ name: null, email: 'me@x.com' }],
			receivedAt: '2026-05-04T10:00:00Z',
			preview: 'p',
			text: 'hello body'
		}
		const { client, rec } = fakeClient({
			async read() {
				return details
			}
		})
		const cmd = createFastmailCommand(client)
		const res = await cmd.run(['read', 'e1'], ctx)
		expect(res.exitCode).toBe(0)
		expect(rec.read).toEqual(['e1'])
		expect(res.stdout).toContain('Subject')
		expect(res.stdout).toContain('a@x.com')
		expect(res.stdout).toContain('hello body')
	})

	test('read without id is a usage error', async () => {
		const { client } = fakeClient()
		const cmd = createFastmailCommand(client)
		const res = await cmd.run(['read'], ctx)
		expect(res.exitCode).not.toBe(0)
		expect(res.stderr).toContain('id')
	})

	test('send parses key:value args and calls jmap.send', async () => {
		const { client, rec } = fakeClient()
		const cmd = createFastmailCommand(client)
		const res = await cmd.run(['send', 'to:bob@x.com', 'subject:hi', 'body:hey'], ctx)
		expect(res.exitCode).toBe(0)
		expect(rec.sent).toEqual([{ to: 'bob@x.com', subject: 'hi', body: 'hey' }])
		expect(res.stdout).toContain('email-1')
	})

	test('send with missing required field fails', async () => {
		const { client } = fakeClient()
		const cmd = createFastmailCommand(client)
		const res = await cmd.run(['send', 'to:bob@x.com'], ctx)
		expect(res.exitCode).not.toBe(0)
		expect(res.stderr).toMatch(/subject|body/)
	})

	test('unknown subcommand fails with help', async () => {
		const { client } = fakeClient()
		const cmd = createFastmailCommand(client)
		const res = await cmd.run(['nope'], ctx)
		expect(res.exitCode).not.toBe(0)
		expect(res.stderr).toContain('nope')
	})

	test('jmap errors map to exit 1 with stderr', async () => {
		const { client } = fakeClient({
			async list() {
				throw new Error('401')
			}
		})
		const cmd = createFastmailCommand(client)
		const res = await cmd.run(['list'], ctx)
		expect(res.exitCode).toBe(1)
		expect(res.stderr).toContain('401')
	})
})
