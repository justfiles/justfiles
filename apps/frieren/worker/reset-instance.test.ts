import type { DestructiveResetBody, ResetDecision } from '@justfiles/core'
import { describe, expect, test, vi } from 'vitest'
import { commitResetAndRestart } from './reset-instance.ts'

const request: DestructiveResetBody = {
	mode: 'wipe',
	fromGeneration: 1,
	operationId: 'op-1'
}

describe('commitResetAndRestart', () => {
	test('terminates immediately after a newly committed reset', async () => {
		const calls: string[] = []
		const committed: ResetDecision = {
			ok: true,
			next: {
				generation: 2,
				committedReset: { operationId: 'op-1', generation: 2 }
			}
		}
		await expect(
			commitResetAndRestart(request, {
				reset: async () => {
					calls.push('commit')
					return committed
				},
				terminate: (reason) => {
					calls.push(reason)
					throw new Error('terminated')
				}
			})
		).rejects.toThrow('terminated')
		expect(calls).toEqual(['commit', 'filesystem reset: op-1'])
	})

	test('returns stale and replay decisions without terminating', async () => {
		const terminate = vi.fn((): never => {
			throw new Error('unexpected')
		})
		await expect(
			commitResetAndRestart(request, {
				reset: async () => ({
					ok: false,
					error: 'generation_stale',
					generation: 2
				}),
				terminate
			})
		).resolves.toEqual({ ok: false, error: 'generation_stale', generation: 2 })
		await expect(
			commitResetAndRestart(request, {
				reset: async () => ({
					ok: true,
					next: { generation: 2 },
					replayed: true
				}),
				terminate
			})
		).resolves.toEqual({ ok: true, generation: 2, replayed: true })
		expect(terminate).not.toHaveBeenCalled()
	})
})
