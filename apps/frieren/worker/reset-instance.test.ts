import type { DbAdapter, DestructiveResetBody, ResetDecision } from '@justfiles/core'
import { describe, expect, test } from 'vitest'
import { commitReset, refuseWritesWhile } from './reset-instance.ts'

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

// Records what actually reached storage, so a refused write is visibly absent.
function adapter(written: string[]): DbAdapter {
	return {
		query: async () => [],
		run: async (sql: string) => {
			written.push(sql)
		},
		transaction: async (fn) => fn(adapter(written))
	}
}

describe('refuseWritesWhile', () => {
	test('lets an instance that is still serving write normally', async () => {
		const written: string[] = []
		const db = refuseWritesWhile(adapter(written), () => false)
		await db.run('INSERT INTO fs_inodes VALUES (1)')
		await db.transaction(async (tx) => tx.run('INSERT INTO fs_dirents VALUES (1)'))
		expect(written).toEqual([
			'INSERT INTO fs_inodes VALUES (1)',
			'INSERT INTO fs_dirents VALUES (1)'
		])
	})

	test('refuses the write an in-flight turn resumes into after a reset commits', async () => {
		// The turn passed every entry check before the reset, awaited the model, and comes
		// back to append its transcript into the tree the reset just created. Nothing asked
		// it to stop, so the write boundary has to.
		const written: string[] = []
		let restarting = false
		const db = refuseWritesWhile(adapter(written), () => restarting)
		const turn = (async () => {
			await Promise.resolve() // the model call
			await db.run('INSERT INTO fs_inodes VALUES (1)')
		})()
		restarting = true
		await expect(turn).rejects.toThrow('restarting')
		expect(written).toEqual([])
	})

	test('refuses a transaction, not just a bare statement', async () => {
		const written: string[] = []
		const db = refuseWritesWhile(adapter(written), () => true)
		await expect(
			db.transaction(async (tx) => tx.run('INSERT INTO fs_inodes VALUES (1)'))
		).rejects.toThrow('restarting')
		expect(written).toEqual([])
	})

	test('keeps reads open, so a closed instance can still say who it is', async () => {
		// `status()` has to answer through the fence — proving the old instance is gone is
		// the one thing that must keep working while it refuses everything else.
		const db = refuseWritesWhile(adapter([]), () => true)
		await expect(db.query('SELECT generation FROM fs_generation')).resolves.toEqual([])
	})
})

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

	test('the reset itself still writes — the boundary closes only once it has committed', async () => {
		// `refuseWritesWhile` reads the flag per call, and `commitReset` runs before the
		// caller sets it, so the truncate and bump go through the same adapter they fence.
		let restarting = false
		const written: string[] = []
		const db = refuseWritesWhile(adapter(written), () => restarting)
		await commitReset(request, {
			reset: async () => {
				await db.run('DELETE FROM fs_inodes')
				return { ok: true, next: { generation: 2 } }
			},
			sync: async () => {
				restarting = true
			}
		})
		expect(written).toEqual(['DELETE FROM fs_inodes'])
		await expect(db.run('INSERT INTO fs_inodes VALUES (1)')).rejects.toThrow('restarting')
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
