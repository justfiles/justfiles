import type { Volume } from '@justfiles/fs'
import { nextFourAmInTimezone, resolveTimezone } from './timezone'

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
