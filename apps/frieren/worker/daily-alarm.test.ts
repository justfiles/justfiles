import type { AgentSession } from '@justfiles/agent'
import { describe, expect, test, vi } from 'vitest'
import { scheduleDailyAlarm } from './daily-alarm.ts'

describe('daily alarm', () => {
	test('uses the agent session maintenance time', async () => {
		const at = new Date('2026-07-06T04:00:00Z').getTime()
		const nextMaintenanceAt = vi.fn(async () => at)
		const storage = {
			getAlarm: vi.fn(async () => null),
			setAlarm: vi.fn(async () => {})
		}
		const ctx = { storage }
		const session = { nextMaintenanceAt } as Pick<AgentSession, 'nextMaintenanceAt'>
		const now = new Date('2026-07-05T10:00:00Z')

		await scheduleDailyAlarm(ctx, session, now)

		expect(nextMaintenanceAt).toHaveBeenCalledWith(now)
		expect(storage.setAlarm).toHaveBeenCalledWith(at)
	})

	test('keeps an existing alarm', async () => {
		const nextMaintenanceAt = vi.fn(async () => 1)
		const storage = {
			getAlarm: vi.fn(async () => 123),
			setAlarm: vi.fn(async () => {})
		}
		const ctx = { storage }

		await scheduleDailyAlarm(ctx, { nextMaintenanceAt })

		expect(nextMaintenanceAt).not.toHaveBeenCalled()
		expect(storage.setAlarm).not.toHaveBeenCalled()
	})
})
