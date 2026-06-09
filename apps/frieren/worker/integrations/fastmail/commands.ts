import type { Command, CommandResult } from '@justfiles/agent'
import type { EmailAddress, EmailDetails, EmailSummary, JmapClient } from './jmap.ts'

const HELP = [
	'fastmail — list, read, send email via Fastmail',
	'',
	'Subcommands:',
	'  list [--limit N] [--unread]           List inbox messages (default 20)',
	'  read <id>                             Fetch and print one message',
	'  mark-read <id>                        Mark a message as read',
	'  send to:<addr> subject:<s> body:<b>   Send a plain-text email'
].join('\n')

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function formatAddr(a: EmailAddress): string {
	return a.name ? `${a.name} <${a.email}>` : a.email
}

function renderList(emails: EmailSummary[]): string {
	if (emails.length === 0) return '(empty inbox)'
	return emails
		.map((e) => {
			const from = e.from.map(formatAddr).join(', ')
			const subject = e.subject ?? '(no subject)'
			return `${e.id}\t${e.receivedAt}\t${from}\t${subject}`
		})
		.join('\n')
}

function renderRead(email: EmailDetails): string {
	const lines = [
		`From: ${email.from.map(formatAddr).join(', ')}`,
		`To: ${email.to.map(formatAddr).join(', ')}`,
		`Date: ${email.receivedAt}`,
		`Subject: ${email.subject ?? '(no subject)'}`,
		'',
		email.text || email.preview
	]
	return lines.join('\n')
}

function parseListArgs(argv: string[]): { limit: number; unread: boolean } | { error: string } {
	let limit = 20
	let unread = false
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i]
		if (tok === '--limit') {
			const val = argv[i + 1]
			const n = val === undefined ? Number.NaN : Number(val)
			if (!Number.isFinite(n) || n <= 0)
				return { error: 'list: --limit requires a positive number' }
			limit = Math.floor(n)
			i++
		} else if (tok === '--unread') {
			unread = true
		} else {
			return { error: `list: unexpected argument: ${tok}` }
		}
	}
	return { limit, unread }
}

function parseSendArgs(
	argv: string[]
): { to: string; subject: string; body: string } | { error: string } {
	const fields: Record<string, string> = {}
	for (const tok of argv) {
		const colon = tok.indexOf(':')
		if (colon < 0) return { error: `send: expected key:value, got "${tok}"` }
		const key = tok.slice(0, colon)
		const value = tok.slice(colon + 1)
		if (!['to', 'subject', 'body'].includes(key)) {
			return { error: `send: unknown field: ${key}` }
		}
		fields[key] = value
	}
	for (const key of ['to', 'subject', 'body']) {
		if (fields[key] === undefined) return { error: `send: missing required field: ${key}` }
	}
	return { to: fields.to, subject: fields.subject, body: fields.body }
}

async function runList(client: JmapClient, argv: string[]): Promise<CommandResult> {
	const parsed = parseListArgs(argv)
	if ('error' in parsed) return { stdout: '', stderr: parsed.error, exitCode: 2 }
	try {
		const emails = await client.list({ limit: parsed.limit, unread: parsed.unread })
		return { stdout: renderList(emails), stderr: '', exitCode: 0 }
	} catch (error) {
		return { stdout: '', stderr: `fastmail list: ${errorMessage(error)}`, exitCode: 1 }
	}
}

async function runMarkRead(client: JmapClient, argv: string[]): Promise<CommandResult> {
	const id = argv[0]
	if (!id) return { stdout: '', stderr: 'mark-read: missing required argument: id', exitCode: 2 }
	try {
		await client.markRead(id)
		return { stdout: `marked ${id} as read`, stderr: '', exitCode: 0 }
	} catch (error) {
		return { stdout: '', stderr: `fastmail mark-read: ${errorMessage(error)}`, exitCode: 1 }
	}
}

async function runRead(client: JmapClient, argv: string[]): Promise<CommandResult> {
	const id = argv[0]
	if (!id) return { stdout: '', stderr: 'read: missing required argument: id', exitCode: 2 }
	try {
		const email = await client.read(id)
		return { stdout: renderRead(email), stderr: '', exitCode: 0 }
	} catch (error) {
		return { stdout: '', stderr: `fastmail read: ${errorMessage(error)}`, exitCode: 1 }
	}
}

async function runSend(client: JmapClient, argv: string[]): Promise<CommandResult> {
	const parsed = parseSendArgs(argv)
	if ('error' in parsed) return { stdout: '', stderr: parsed.error, exitCode: 2 }
	try {
		const { id } = await client.send(parsed)
		return { stdout: `sent ${id}`, stderr: '', exitCode: 0 }
	} catch (error) {
		return { stdout: '', stderr: `fastmail send: ${errorMessage(error)}`, exitCode: 1 }
	}
}

export function createFastmailCommand(client: JmapClient): Command {
	return {
		name: 'fastmail',
		summary: 'Fastmail email (list/read/send)',
		async run(argv) {
			if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
				return { stdout: HELP, stderr: '', exitCode: 0 }
			}
			const [sub, ...rest] = argv
			switch (sub) {
				case 'list':
					return runList(client, rest)
				case 'read':
					return runRead(client, rest)
				case 'mark-read':
					return runMarkRead(client, rest)
				case 'send':
					return runSend(client, rest)
				default:
					return {
						stdout: '',
						stderr: `fastmail: unknown subcommand: ${sub}\n${HELP}`,
						exitCode: 2
					}
			}
		}
	}
}
