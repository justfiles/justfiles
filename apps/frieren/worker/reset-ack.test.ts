import type { DestructiveResetBody } from '@justfiles/core'
import { describe, expect, test, vi } from 'vitest'
import { acknowledgeReset, type ResetRestartStub } from './reset-ack.ts'

const request: DestructiveResetBody = {
	mode: 'wipe',
	fromGeneration: 1,
	operationId: 'op-1'
}

// No real waiting; the backoff is the shape under test, not the clock.
const instant = { delays: [0, 0, 0], wait: async () => {} }

/**
 * A namespace that behaves like the real one across a reset.
 *
 * `resetAndRestart` commits and destroys the instance, so it never returns — and the handle
 * it went out on is DEAD from then on, rejecting everything without reaching an object. Only
 * a handle taken afterwards works, and then only once the replacement has started.
 *
 * Modelling the dead handle is the point of this fake: the protocol this replaced polled the
 * committing handle, and in production that reached a Durable Object zero times across two
 * resets and ten attempts.
 */
function namespace(options: { commits?: boolean; startupCalls?: number } = {}) {
	const commits = options.commits ?? true
	let starting = options.startupCalls ?? 0
	let committed: string | undefined
	let generation = 1
	let aborted = false
	const calls: string[] = []
	const connect = (): ResetRestartStub => {
		const bornAfterAbort = aborted
		const reachable = async () => {
			if (aborted && !bornAfterAbort) throw new Error('the Durable Object was reset')
			if (bornAfterAbort && starting > 0) {
				starting -= 1
				throw new Error('starting up')
			}
		}
		return {
			resetAndRestart: async (req) => {
				await reachable()
				calls.push('resetAndRestart')
				if (committed === req.operationId) return { ok: true, generation, replayed: true }
				if (!commits) throw new Error('failed before committing')
				committed = req.operationId
				generation += 1
				aborted = true
				// Committed, flushed, gone — the caller is hung up on mid-call.
				throw new Error('the Durable Object was reset')
			},
			resetStatus: async (operationId) => {
				await reachable()
				calls.push('resetStatus')
				return committed === operationId
					? { committed: true, generation }
					: { committed: false, generation }
			}
		}
	}
	return { connect, calls, didAbort: () => aborted }
}

describe('acknowledgeReset', () => {
	test('confirms a reset that committed before the instance disconnected', async () => {
		const ns = namespace()
		const result = await acknowledgeReset(ns.connect, request, instant)
		expect(result).toEqual({ ok: true, generation: 2 })
		expect(ns.didAbort()).toBe(true)
	})

	test('confirms over a fresh handle, never the one the reset went out on', async () => {
		// The regression, stated directly: the committing handle is dead, so a protocol that
		// reuses it can never see the commit it just made.
		const ns = namespace()
		const dead = ns.connect()
		await acknowledgeReset(ns.connect, request, instant)
		await expect(dead.resetStatus('op-1')).rejects.toThrow('was reset')
	})

	test('waits out a replacement that is still starting', async () => {
		const ns = namespace({ startupCalls: 2 })
		await expect(acknowledgeReset(ns.connect, request, instant)).resolves.toEqual({
			ok: true,
			generation: 2
		})
	})

	test('never accepts a disconnect before commit as success', async () => {
		// A reset that failed on its way in looks exactly like one that committed and died.
		// Only storage can tell them apart, and here it says no.
		const ns = namespace({ commits: false })
		const result = await acknowledgeReset(ns.connect, request, instant)
		expect(result).toEqual({ ok: false, error: 'reset_unconfirmed', generation: 1 })
	})

	test('bounds confirmation and reports the generation it did observe', async () => {
		const stub: ResetRestartStub = {
			resetAndRestart: async () => {
				throw new Error('disconnected')
			},
			resetStatus: async () => ({ committed: false, generation: 7 })
		}
		await expect(acknowledgeReset(() => stub, request, instant)).resolves.toEqual({
			ok: false,
			error: 'reset_unconfirmed',
			generation: 7
		})
	})

	test('reports unconfirmed rather than guessing when nothing answers at all', async () => {
		const resetStatus = vi.fn(async () => {
			throw new Error('unreachable')
		})
		const stub = {
			resetAndRestart: async () => {
				throw new Error('disconnected')
			},
			resetStatus
		} as unknown as ResetRestartStub
		await expect(acknowledgeReset(() => stub, request, instant)).resolves.toEqual({
			ok: false,
			error: 'reset_unconfirmed',
			generation: undefined
		})
		expect(resetStatus).toHaveBeenCalledTimes(instant.delays.length)
	})

	test('a stale decision is returned without confirming anything', async () => {
		const resetStatus = vi.fn()
		const stub = {
			resetAndRestart: async () => ({ ok: false, error: 'generation_stale', generation: 3 }),
			resetStatus
		} as unknown as ResetRestartStub
		const result = await acknowledgeReset(() => stub, request, instant)
		expect(result).toEqual({ ok: false, error: 'generation_stale', generation: 3 })
		expect(resetStatus).not.toHaveBeenCalled()
	})

	test('a redelivered reset replays the committed one instead of resetting again', async () => {
		// The instance that committed is already gone, so the replay is answered by its
		// replacement and must not destroy that one too.
		const ns = namespace()
		await acknowledgeReset(ns.connect, request, instant)
		const again = await acknowledgeReset(ns.connect, request, instant)
		expect(again).toEqual({ ok: true, generation: 2, replayed: true })
		// Still generation 2: the second delivery truncated nothing.
		expect(ns.calls.filter((c) => c === 'resetAndRestart')).toHaveLength(2)
	})
})
