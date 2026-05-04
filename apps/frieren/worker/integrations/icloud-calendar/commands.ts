import type { Command, CommandResult } from '../../bash/registry.ts'
import { DEFAULT_TIMEZONE, isoToTimezone } from '../../timezone.ts'
import type { CalDavClient, CreateEventInput } from './caldav.ts'

const HELP = [
	'icloud-calendar — list, read, create, delete iCloud Calendar events',
	'',
	'Subcommands:',
	'  list [--days N] [--tz <iana>]                          List events in next N days (default 7)',
	'  read <uid> [--tz <iana>]                               Show full details for one event',
	"  create date:<iso> title:<text> [duration:<minutes>]    Create an event; date may include offset (e.g. 2026-05-10T09:00:00-04:00) or 'Z' for UTC",
	'  delete <uid>                                           Delete an event by uid',
	'',
	'Times are rendered in the user’s timezone (from /profiles/user.md `timezone` field).',
	'Override per-call with --tz <IANA name>, e.g. --tz America/New_York.'
].join('\n')

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function takeTzFlag(argv: string[]): { argv: string[]; tz?: string } | { error: string } {
	const out: string[] = []
	let tz: string | undefined
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--tz') {
			const val = argv[i + 1]
			if (!val) return { error: '--tz requires an IANA timezone name' }
			tz = val
			i++
		} else {
			out.push(argv[i])
		}
	}
	return { argv: out, tz }
}

function parseDays(argv: string[]): { days: number } | { error: string } {
	let days = 7
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i]
		if (tok === '--days') {
			const val = argv[i + 1]
			const n = val === undefined ? Number.NaN : Number(val)
			if (!Number.isFinite(n) || n <= 0) return { error: 'list: --days requires a positive number' }
			days = Math.floor(n)
			i++
		} else {
			return { error: `list: unexpected argument: ${tok}` }
		}
	}
	return { days }
}

function parseCreateArgs(argv: string[]): CreateEventInput | { error: string } {
	const fields: Record<string, string> = {}
	for (const tok of argv) {
		const colon = tok.indexOf(':')
		if (colon < 0) return { error: `create: expected key:value, got "${tok}"` }
		const key = tok.slice(0, colon)
		const value = tok.slice(colon + 1)
		if (!['date', 'title', 'duration', 'description', 'location'].includes(key)) {
			return { error: `create: unknown field: ${key}` }
		}
		fields[key] = value
	}
	for (const key of ['date', 'title']) {
		if (!fields[key]) return { error: `create: missing required field: ${key}` }
	}
	const input: CreateEventInput = { dtstart: fields.date, summary: fields.title }
	if (fields.duration !== undefined) {
		const n = Number(fields.duration)
		if (!Number.isFinite(n) || n <= 0)
			return { error: 'create: duration must be a positive number of minutes' }
		input.durationMinutes = Math.floor(n)
	}
	if (fields.description) input.description = fields.description
	if (fields.location) input.location = fields.location
	return input
}

function renderList(events: Awaited<ReturnType<CalDavClient['listEvents']>>, tz: string): string {
	if (events.length === 0) return '(no events)'
	return events.map((e) => `${e.uid}\t${isoToTimezone(e.dtstart, tz)}\t${e.summary}`).join('\n')
}

function renderRead(event: Awaited<ReturnType<CalDavClient['readEvent']>>, tz: string): string {
	const lines = [
		`UID: ${event.uid}`,
		`Summary: ${event.summary}`,
		`Start: ${isoToTimezone(event.dtstart, tz)}`,
		`End: ${isoToTimezone(event.dtend, tz)}`,
		`Location: ${event.location ?? ''}`,
		`Description: ${event.description ?? ''}`
	]
	return lines.join('\n')
}

async function runList(client: CalDavClient, argv: string[], tz: string): Promise<CommandResult> {
	const parsed = parseDays(argv)
	if ('error' in parsed) return { stdout: '', stderr: parsed.error, exitCode: 2 }
	try {
		const events = await client.listEvents({ days: parsed.days })
		return { stdout: renderList(events, tz), stderr: '', exitCode: 0 }
	} catch (error) {
		return { stdout: '', stderr: `icloud-calendar list: ${errorMessage(error)}`, exitCode: 1 }
	}
}

async function runRead(client: CalDavClient, argv: string[], tz: string): Promise<CommandResult> {
	const uid = argv[0]
	if (!uid) return { stdout: '', stderr: 'read: missing required argument: uid', exitCode: 2 }
	try {
		const event = await client.readEvent(uid)
		return { stdout: renderRead(event, tz), stderr: '', exitCode: 0 }
	} catch (error) {
		return { stdout: '', stderr: `icloud-calendar read: ${errorMessage(error)}`, exitCode: 1 }
	}
}

async function runCreate(client: CalDavClient, argv: string[]): Promise<CommandResult> {
	const parsed = parseCreateArgs(argv)
	if ('error' in parsed) return { stdout: '', stderr: parsed.error, exitCode: 2 }
	try {
		const { uid } = await client.createEvent(parsed)
		return { stdout: uid, stderr: '', exitCode: 0 }
	} catch (error) {
		return { stdout: '', stderr: `icloud-calendar create: ${errorMessage(error)}`, exitCode: 1 }
	}
}

async function runDelete(client: CalDavClient, argv: string[]): Promise<CommandResult> {
	const uid = argv[0]
	if (!uid) return { stdout: '', stderr: 'delete: missing required argument: uid', exitCode: 2 }
	try {
		await client.deleteEvent(uid)
		return { stdout: `deleted ${uid}`, stderr: '', exitCode: 0 }
	} catch (error) {
		return { stdout: '', stderr: `icloud-calendar delete: ${errorMessage(error)}`, exitCode: 1 }
	}
}

export interface IcloudCalendarCommandOptions {
	getTimezone?: () => Promise<string> | string
}

export function createIcloudCalendarCommand(
	client: CalDavClient,
	options: IcloudCalendarCommandOptions = {}
): Command {
	const { getTimezone } = options
	return {
		name: 'icloud-calendar',
		summary: 'iCloud Calendar (list/read/create/delete)',
		async run(argv) {
			if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
				return { stdout: HELP, stderr: '', exitCode: 0 }
			}
			const [sub, ...rest] = argv
			const tzParse = takeTzFlag(rest)
			if ('error' in tzParse) return { stdout: '', stderr: tzParse.error, exitCode: 2 }
			const tz = tzParse.tz ?? (getTimezone ? await getTimezone() : DEFAULT_TIMEZONE)
			switch (sub) {
				case 'list':
					return runList(client, tzParse.argv, tz)
				case 'read':
					return runRead(client, tzParse.argv, tz)
				case 'create':
					return runCreate(client, tzParse.argv)
				case 'delete':
					return runDelete(client, tzParse.argv)
				default:
					return {
						stdout: '',
						stderr: `icloud-calendar: unknown subcommand: ${sub}\n${HELP}`,
						exitCode: 2
					}
			}
		}
	}
}
