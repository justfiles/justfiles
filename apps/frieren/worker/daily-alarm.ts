import { nextFourAmInTimezone, resolveTimezone } from '@justfiles/agent'
import { sweepTrash } from '@justfiles/app'
import type { Volume } from '@justfiles/fs'
import type { Storage } from '@justfiles/fs/storage'

type AlarmContext = {
	storage: {
		getAlarm(): Promise<number | null>
		setAlarm(at: number | Date): Promise<void>
	}
}

export async function runDailyMaintenance(storage: Storage, volume: Volume): Promise<void> {
	await sweepTrash(volume).catch(() => {})
	await storage.caps?.content?.gcUnreferenced().catch(() => {})
}

export async function scheduleDailyAlarm(
	ctx: AlarmContext,
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
