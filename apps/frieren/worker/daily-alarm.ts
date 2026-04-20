import type { Volume } from '@justfiles/fs'
import { parseFrontmatter } from './markdown'

const DEFAULT_TIMEZONE = 'UTC'
const PROFILE_PATH = '/profiles/user.md'

export async function scheduleDailyAlarm(
	ctx: DurableObjectState,
	volume: Volume,
	cfTimezone: string | undefined,
	now: Date = new Date()
): Promise<void> {
	if ((await ctx.storage.getAlarm()) !== null) return
	const tz = await resolveTimezone(volume, cfTimezone)
	const at = nextFourAmInTimezone(now, tz)
	if (at === null) return
	await ctx.storage.setAlarm(at)
}

async function resolveTimezone(volume: Volume, cfTimezone: string | undefined): Promise<string> {
	if (await volume.exists(PROFILE_PATH)) {
		const fm = parseFrontmatter(new TextDecoder().decode(await volume.readFile(PROFILE_PATH)))
		if (fm.timezone) return fm.timezone
	}
	return cfTimezone ?? DEFAULT_TIMEZONE
}

export function nextFourAmInTimezone(now: Date, tz: string): number | null {
	try {
		const { year, month, day } = dateInTz(now, tz)
		const today4am = zonedTimeToUtcMs(year, month, day, 4, 0, 0, tz)
		if (today4am > now.getTime()) return today4am
		const next = new Date(Date.UTC(year, month - 1, day) + 86400000)
		return zonedTimeToUtcMs(
			next.getUTCFullYear(),
			next.getUTCMonth() + 1,
			next.getUTCDate(),
			4,
			0,
			0,
			tz
		)
	} catch {
		return null
	}
}

function dateInTz(at: Date, tz: string): { year: number; month: number; day: number } {
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(at)
	const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
	return { year: get('year'), month: get('month'), day: get('day') }
}

function zonedTimeToUtcMs(
	y: number,
	mo: number,
	d: number,
	h: number,
	mi: number,
	s: number,
	tz: string
): number {
	const asUtc = Date.UTC(y, mo - 1, d, h, mi, s)
	const fmt = new Intl.DateTimeFormat('en-GB', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	})
	const parts = fmt.formatToParts(new Date(asUtc))
	const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
	const displayedUtc = Date.UTC(
		get('year'),
		get('month') - 1,
		get('day'),
		get('hour') === 24 ? 0 : get('hour'),
		get('minute'),
		get('second')
	)
	return asUtc + (asUtc - displayedUtc)
}
