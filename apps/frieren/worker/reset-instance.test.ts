import type { DestructiveResetBody, ResetDecision } from '@justfiles/core'
import { describe, expect, test } from 'vitest'
import { commitReset } from './reset-instance.ts'

const request: DestructiveResetBody = {
	mode: 'wipe',
	fromGeneration: 1,
	operationId: 'op-1'
}

// Records the order of the three steps that must not be reordered, and stands in for an
// `abort()` that never returns.
function operations(decision: ResetDecision) {
	const order: string[] = []
	let reason: string | undefined
	return {
		order,
		reason: () => reason,
		reset: async () => {
			order.push('reset')
			return decision
		},
		sync: async () => {
			order.push('sync')
		},
		terminate: (why: string): never => {
			order.push('terminate')
			reason = why
			throw new Error('the Durable Object was reset')
		}
	}
}

describe('commitReset', () => {
	test('flushes to disk before terminating, so the restart cannot discard the commit', async () => {
		// The regression: DO SQLite writes ride the event's implicit transaction, which only
		// commits when the output gate opens. Terminating stops that happening, so without the
		// flush the truncate + bump are rolled back and the reset silently does nothing (#425).
		const ops = operations({ ok: true, next: { generation: 2 } })
		await expect(commitReset(request, ops)).rejects.toThrow('was reset')
		expect(ops.order).toEqual(['reset', 'sync', 'terminate'])
	})

	test('names the operation in the termination reason, so the abort is traceable', async () => {
		const ops = operations({ ok: true, next: { generation: 2 } })
		await expect(commitReset(request, ops)).rejects.toThrow()
		expect(ops.reason()).toBe('filesystem reset: op-1')
	})

	test('a stale decision neither flushes nor terminates', async () => {
		// Nothing was written, and the instance is still perfectly good — tearing it down
		// would turn a routine CAS rejection into a cold start.
		const ops = operations({ ok: false, error: 'generation_stale', generation: 5 })
		await expect(commitReset(request, ops)).resolves.toEqual({
			ok: false,
			error: 'generation_stale',
			generation: 5
		})
		expect(ops.order).toEqual(['reset'])
	})

	test('a replay answers with the committed generation and terminates nothing', async () => {
		// Commit and termination are atomic, so a recorded operation proves the instance that
		// made it is already gone: whoever is answering was built afterwards and owns this
		// generation. Destroying it would cost a cold start to change nothing.
		const ops = operations({
			ok: true,
			next: { generation: 2, committedReset: { operationId: 'op-1', generation: 2 } },
			replayed: true
		})
		await expect(commitReset(request, ops)).resolves.toEqual({
			ok: true,
			generation: 2,
			replayed: true
		})
		expect(ops.order).toEqual(['reset'])
	})

	test('a failed flush fails the reset instead of terminating over an unsafe commit', async () => {
		// Terminating here would discard the very write we could not confirm.
		const order: string[] = []
		const result = commitReset(request, {
			reset: async () => ({ ok: true, next: { generation: 2 } }),
			sync: async () => {
				throw new Error('disk')
			},
			terminate: (): never => {
				order.push('terminate')
				throw new Error('should not reach')
			}
		})
		await expect(result).rejects.toThrow('disk')
		expect(order).toEqual([])
	})
})
