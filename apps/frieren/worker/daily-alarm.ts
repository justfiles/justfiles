import type { AgentSession } from '@justfiles/agent'

interface AlarmState {
	storage: {
		getAlarm(): Promise<number | null>
		setAlarm(at: number): Promise<void>
	}
}

export async function scheduleDailyAlarm(
	ctx: AlarmState,
	session: Pick<AgentSession, 'nextMaintenanceAt'> | undefined,
	now: Date = new Date()
): Promise<void> {
	if (!session || (await ctx.storage.getAlarm()) !== null) return
	const at = await session.nextMaintenanceAt(now)
	if (at === null) return
	await ctx.storage.setAlarm(at)
}
