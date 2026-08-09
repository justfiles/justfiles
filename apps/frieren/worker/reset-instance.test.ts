import type { DestructiveResetBody, ResetDecision } from '@justfiles/core'
import { describe, expect, test } from 'vitest'
import { commitReset } from './reset-instance.ts'

const request: DestructiveResetBody = {
	mode: 'wipe',
	fromGeneration: 1,
	operationId: 'op-1'
}

// Records the order of the two things that must not be reordered: the write, then the
// flush that makes it survive the restart the caller is about to trigger.
function operations(decision: ResetDecision) {
	const order: string[] = []
	return {
		order,
		reset: async () => {
			order.push('reset')
			return decision
		},
		sync: async () => {
			order.push('sync')
		}
	}
}

describe('commitReset', () => {
	test('flushes to disk before answering, so the restart cannot discard the commit', async () => {
		// The regression: DO SQLite writes ride the event's implicit transaction, which only
		// commits when the output gate opens. The restart that follows this call stops that
		// happening, so without the flush the truncate + bump are rolled back and the reset
		// silently does nothing (#425).
		const ops = operations({ ok: true, next: { generation: 2 } })
		const result = await commitReset(request, ops)
		expect(result).toEqual({ ok: true, generation: 2 })
		expect(ops.order).toEqual(['reset', 'sync'])
	})

	test('a stale decision is returned without flushing anything', async () => {
		const ops = operations({ ok: false, error: 'generation_stale', generation: 5 })
		const result = await commitReset(request, ops)
		expect(result).toEqual({ ok: false, error: 'generation_stale', generation: 5 })
		expect(ops.order).toEqual(['reset'])
	})

	test('a replay answers with the generation the first delivery committed', async () => {
		const ops = operations({
			ok: true,
			next: { generation: 2, committedReset: { operationId: 'op-1', generation: 2 } },
			replayed: true
		})
		const result = await commitReset(request, ops)
		expect(result).toEqual({ ok: true, generation: 2, replayed: true })
	})

	test('a failed flush fails the reset rather than reporting a commit that may not survive', async () => {
		const result = commitReset(request, {
			reset: async () => ({ ok: true, next: { generation: 2 } }),
			sync: async () => {
				throw new Error('disk')
			}
		})
		await expect(result).rejects.toThrow('disk')
	})
})
