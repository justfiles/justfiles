import type { DestructiveResetBody, ResetResult, ResetStatus } from '@justfiles/core'
import { describe, expect, test, vi } from 'vitest'
import { acknowledgeReset, type ResetRestartStub } from './reset-ack.ts'

const request: DestructiveResetBody = {
	mode: 'wipe',
	fromGeneration: 1,
	operationId: 'op-1'
}

function stub(options: {
	reset: () => Promise<ResetResult>
	status: () => Promise<ResetStatus>
}): ResetRestartStub {
	return {
		resetAndRestart: options.reset,
		resetStatus: options.status
	}
}

describe('acknowledgeReset', () => {
	test('confirms a reset that committed before the instance disconnected', async () => {
		const result = await acknowledgeReset(
			stub({
				reset: async () => {
					throw new Error('disconnected')
				},
				status: async () => ({ committed: true, generation: 2 })
			}),
			request,
			{ delays: [0] }
		)
		expect(result).toEqual({ ok: true, generation: 2 })
	})

	test('never accepts a disconnect before commit as success', async () => {
		const status = vi.fn(async () => ({ committed: false, generation: 1 }) as const)
		const result = await acknowledgeReset(
			stub({
				reset: async () => {
					throw new Error('disconnected')
				},
				status
			}),
			request,
			{ delays: [0, 0, 0] }
		)
		expect(result).toEqual({ ok: false, error: 'reset_unconfirmed', generation: 1 })
		expect(status).toHaveBeenCalledTimes(3)
	})

	test('returns stale reset decisions without confirmation', async () => {
		const status = vi.fn()
		const result = await acknowledgeReset(
			stub({
				reset: async () => ({
					ok: false,
					error: 'generation_stale',
					generation: 3
				}),
				status
			}),
			request
		)
		expect(result).toEqual({ ok: false, error: 'generation_stale', generation: 3 })
		expect(status).not.toHaveBeenCalled()
	})

	test('returns an idempotent duplicate directly', async () => {
		const status = vi.fn()
		const result = await acknowledgeReset(
			stub({
				reset: async () => ({ ok: true, generation: 2, replayed: true }),
				status
			}),
			request
		)
		expect(result).toEqual({ ok: true, generation: 2, replayed: true })
		expect(status).not.toHaveBeenCalled()
	})

	test('bounds retries while a fresh instance is unavailable', async () => {
		const status = vi.fn(async () => {
			throw new Error('restarting')
		})
		await expect(
			acknowledgeReset(
				stub({
					reset: async () => {
						throw new Error('disconnected')
					},
					status
				}),
				request,
				{ delays: [0, 0] }
			)
		).resolves.toEqual({ ok: false, error: 'reset_unconfirmed', generation: undefined })
		expect(status).toHaveBeenCalledTimes(2)
	})
})
