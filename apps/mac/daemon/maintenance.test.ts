import type { AgentSession } from '@justfiles/agent'
import { expect, test, vi } from 'vitest'
import { scheduleDailyMaintenance } from './maintenance.ts'

test('the Mac maintenance timer uses and reschedules from the agent session time', async () => {
	const now = new Date('2026-07-05T10:00:00Z')
	const tomorrow = new Date('2026-07-06T04:00:00Z').getTime()
	const nextDay = new Date('2026-07-07T04:00:00Z').getTime()
	const session = {
		nextMaintenanceAt: vi.fn().mockResolvedValueOnce(tomorrow).mockResolvedValueOnce(nextDay),
		runMaintenance: vi.fn(async () => {})
	} satisfies Pick<AgentSession, 'nextMaintenanceAt' | 'runMaintenance'>
	const clock = vi.fn().mockReturnValueOnce(now).mockReturnValueOnce(new Date(tomorrow))
	const callbacks: Array<() => void> = []
	const setTimer = vi.fn((callback: () => void) => callbacks.push(callback))

	await scheduleDailyMaintenance(session, clock, setTimer)

	expect(session.nextMaintenanceAt).toHaveBeenCalledWith(now)
	expect(setTimer).toHaveBeenCalledWith(callbacks[0], tomorrow - now.getTime())
	callbacks[0]?.()
	await vi.waitFor(() => expect(session.runMaintenance).toHaveBeenCalledOnce())
	await vi.waitFor(() => expect(session.nextMaintenanceAt).toHaveBeenCalledTimes(2))
	expect(session.nextMaintenanceAt).toHaveBeenLastCalledWith(new Date(tomorrow))
	expect(setTimer).toHaveBeenLastCalledWith(callbacks[1], nextDay - tomorrow)
})
