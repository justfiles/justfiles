import type { AgentSession } from '@justfiles/agent'

type MaintenanceSession = Pick<AgentSession, 'nextMaintenanceAt' | 'runMaintenance'>
type SetTimer = (callback: () => void, delay: number) => unknown

export async function scheduleDailyMaintenance(
	session: MaintenanceSession,
	now: () => Date = () => new Date(),
	setTimer: SetTimer = setTimeout
): Promise<void> {
	const current = now()
	const at = await session.nextMaintenanceAt(current)
	if (at === null) return
	setTimer(
		() => {
			void run().catch((error) => console.error('[agent] maintenance alarm failed:', error))
		},
		Math.max(0, at - current.getTime())
	)

	async function run(): Promise<void> {
		await session.runMaintenance()
		await scheduleDailyMaintenance(session, now, setTimer)
	}
}
