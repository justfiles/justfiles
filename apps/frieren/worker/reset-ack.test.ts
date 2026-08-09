import type { DestructiveResetBody, ResetResult } from '@justfiles/core'
import { describe, expect, test, vi } from 'vitest'
import { type ResetRestartStub, resetAndTerminate } from './reset-ack.ts'

const request: DestructiveResetBody = {
	mode: 'wipe',
	fromGeneration: 1,
	operationId: 'op-1'
}

// No real waiting; the delays are the shape under test, not the clock.
const instant = { delays: [0, 0, 0], wait: async () => {} }

/**
 * A namespace that behaves like the real one across a restart.
 *
 * `terminate` aborts the instance: the handle it went out on is dead from then on, and a
 * handle taken afterwards reaches a REPLACEMENT with a new `instanceId` — after
 * `startupCalls` attempts have failed, standing in for a cold start. Modelling both is the
 * point: the protocol this replaced polled the dead handle and never once reached a
 * replacement in production (#425).
 */
function namespace(
	onCommit: () => Promise<ResetResult>,
	options: { startupCalls?: number; neverRestarts?: boolean; fencedFromTheStart?: boolean } = {}
) {
	const calls: string[] = []
	let starting = options.startupCalls ?? 0
	let live = {
		instanceId: 'boot-1',
		generation: 1,
		// A committing instance stands down and stays that way until it is replaced.
		restarting: options.fencedFromTheStart ?? false
	}
	let aborted = false
	const connect = (): ResetRestartStub => {
		const bornAfterAbort = aborted
		const reachable = async () => {
			// The handle the abort went out on never works again.
			if (aborted && !bornAfterAbort) throw new Error('the Durable Object was reset')
			// Only a replacement is ever cold; the instance that took the commit is warm.
			if (bornAfterAbort && starting > 0) {
				starting -= 1
				throw new Error('starting up')
			}
		}
		return {
			status: async () => {
				await reachable()
				calls.push('status')
				return live
			},
			commitReset: async () => {
				await reachable()
				calls.push('commitReset')
				const result = await onCommit()
				if (result.ok && !result.replayed) live = { ...live, restarting: true }
				return result
			},
			terminate: async () => {
				await reachable()
				calls.push('terminate')
				aborted = true
				if (!options.neverRestarts)
					live = { instanceId: 'boot-2', generation: 2, restarting: false }
				throw new Error('the Durable Object was reset')
			}
		}
	}
	return { connect, calls, didAbort: () => aborted }
}

describe('resetAndTerminate', () => {
	test('answers only once a replacement instance is serving', async () => {
		const ns = namespace(async () => ({ ok: true, generation: 2 }))
		const result = await resetAndTerminate(ns.connect, request, instant)
		expect(result).toEqual({ ok: true, generation: 2 })
		// Commit acknowledged before anything is torn down; the probe follows the restart.
		expect(ns.calls).toEqual(['status', 'commitReset', 'terminate', 'status'])
	})

	test('waits out a replacement that is still starting', async () => {
		const ns = namespace(async () => ({ ok: true, generation: 2 }), { startupCalls: 2 })
		await expect(resetAndTerminate(ns.connect, request, instant)).resolves.toEqual({
			ok: true,
			generation: 2
		})
		expect(ns.didAbort()).toBe(true)
	})

	test('an unreplaced instance is refused, and the committed reset still reported', async () => {
		// `neverRestarts` leaves `instanceId` at boot-1 while storage still moves to
		// generation 2 — so a generation check would pass against the very instance we are
		// trying to replace, and only the identity check refuses it.
		//
		// And refusing it must not turn a real reset into a failure: the commit is durable
		// and already acknowledged, so the probe is readiness, never evidence.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const ns = namespace(async () => ({ ok: true, generation: 2 }), { neverRestarts: true })
		await expect(resetAndTerminate(ns.connect, request, instant)).resolves.toEqual({
			ok: true,
			generation: 2
		})
		expect(warn).toHaveBeenCalledOnce()
		warn.mockRestore()
	})

	test('the restart rejecting is the success case, not a failed reset', async () => {
		const ns = namespace(async () => ({ ok: true, generation: 2 }))
		await expect(resetAndTerminate(ns.connect, request, instant)).resolves.toEqual({
			ok: true,
			generation: 2
		})
	})

	test('a stale decision is returned as-is, with nothing restarted', async () => {
		const ns = namespace(async () => ({ ok: false, error: 'generation_stale', generation: 3 }))
		const result = await resetAndTerminate(ns.connect, request, instant)
		expect(result).toEqual({ ok: false, error: 'generation_stale', generation: 3 })
		expect(ns.calls).toEqual(['status', 'commitReset'])
		expect(ns.didAbort()).toBe(false)
	})

	test('a replay answered by a replacement is left alone', async () => {
		// Not standing down ⇒ this instance was built after the commit, so it owns the
		// generation it is serving and tearing it down would only cost a cold start.
		const ns = namespace(async () => ({ ok: true, generation: 2, replayed: true }))
		const result = await resetAndTerminate(ns.connect, request, instant)
		expect(result).toEqual({ ok: true, generation: 2, replayed: true })
		expect(ns.calls).toEqual(['status', 'commitReset'])
		expect(ns.didAbort()).toBe(false)
	})

	test('a replay answered by the committing instance still restarts it', async () => {
		// An invocation that died after the commit but before dispatching the restart leaves
		// the committing instance alive and fenced. The retry reaches THAT instance, and
		// returning early would strand it — fenced, serving nothing, never replaced.
		const ns = namespace(async () => ({ ok: true, generation: 2, replayed: true }), {
			fencedFromTheStart: true
		})
		const result = await resetAndTerminate(ns.connect, request, instant)
		expect(result).toEqual({ ok: true, generation: 2, replayed: true })
		expect(ns.calls).toEqual(['status', 'commitReset', 'terminate', 'status'])
		expect(ns.didAbort()).toBe(true)
	})

	test('an instance that did not die is asked again, not left fenced', async () => {
		// The fence has no deadline, so giving up on a live-but-standing-down instance would
		// leave it refusing traffic indefinitely.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const ns = namespace(async () => ({ ok: true, generation: 2 }), { neverRestarts: true })
		await resetAndTerminate(ns.connect, request, instant)
		// One dispatch up front, then one per probe that still finds it standing down.
		expect(ns.calls.filter((c) => c === 'terminate')).toHaveLength(1 + instant.delays.length)
		warn.mockRestore()
	})

	test('a commit that fails outright is not reported as a reset', async () => {
		const ns = namespace(async () => {
			throw new Error('unreachable')
		})
		await expect(resetAndTerminate(ns.connect, request, instant)).rejects.toThrow('unreachable')
		expect(ns.didAbort()).toBe(false)
	})
})
