import { describe, expect, test } from 'vitest'
import { promptReply, snapshotMessage, updateMessages } from './protocol'
import type { SessionUpdate, StartTurnResult } from './session'

describe('session protocol', () => {
	test('maps prompt admission to one small reply', () => {
		const result: StartTurnResult = {
			accepted: true,
			done: Promise.resolve('hello')
		}

		expect(promptReply(result)).toEqual({ type: 'accepted' })
		expect(promptReply({ accepted: false })).toEqual({ type: 'rejected', reason: 'busy' })
	})

	test('maps history and status in a snapshot', () => {
		expect(
			snapshotMessage({ history: [], status: { state: 'thinking' } }, () => ['shown'])
		).toEqual({
			type: 'snapshot',
			history: ['shown'],
			status: { state: 'thinking' }
		})
	})

	test('maps history replacements to snapshots with status', () => {
		const update: SessionUpdate = {
			type: 'snapshot',
			snapshot: { history: [], status: { state: 'idle' } }
		}

		expect(updateMessages(update, () => ['shown'])).toEqual([
			{ type: 'snapshot', history: ['shown'], status: { state: 'idle' } }
		])
	})

	test('maps durable batches to individual item messages', () => {
		const update: SessionUpdate = { type: 'items', items: [] }

		expect(updateMessages(update, () => ['one', 'two'])).toEqual([
			{ type: 'item', item: 'one' },
			{ type: 'item', item: 'two' }
		])
	})

	test('keeps status and errors together', () => {
		const update: SessionUpdate = {
			type: 'status',
			status: { state: 'idle' },
			error: { message: 'sign in', route: { kind: 'settings', pane: 'accounts' } }
		}

		expect(updateMessages(update)).toEqual([update])
	})
})
