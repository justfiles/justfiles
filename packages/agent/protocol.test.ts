import { describe, expect, test } from 'vitest'
import {
	promptReply,
	sessionEntriesToTranscriptItems,
	snapshotMessage,
	updateMessages
} from './protocol'
import type { SessionUpdate, StartTurnResult } from './session'
import type { SessionEntry } from './session.manager'
import { legacyActivityDetail } from './transcript'

const ts = '2026-08-28T00:00:00.000Z'

function entry(id: string, value: object): SessionEntry {
	return { id, parentId: null, ts, ...value } as SessionEntry
}

describe('session protocol', () => {
	test('maps prompt admission to one small reply', () => {
		const result: StartTurnResult = { accepted: true, done: Promise.resolve('hello') }

		expect(promptReply(result)).toEqual({ type: 'accepted' })
		expect(promptReply({ accepted: false })).toEqual({ type: 'rejected', reason: 'busy' })
	})

	test('projects history and status in a snapshot', () => {
		expect(
			snapshotMessage({
				history: [entry('a1', { type: 'message', role: 'assistant', content: 'Done.' })],
				status: { state: 'thinking' }
			})
		).toEqual({
			type: 'snapshot',
			history: [{ id: 'a1', type: 'message', role: 'assistant', content: 'Done.' }],
			status: { state: 'thinking' }
		})
	})

	test('maps history replacements to projected snapshots', () => {
		const update: SessionUpdate = {
			type: 'snapshot',
			snapshot: {
				history: [entry('u1', { type: 'message', role: 'user', content: 'Again.' })],
				status: { state: 'idle' }
			}
		}

		expect(updateMessages(update)).toEqual([
			{
				type: 'snapshot',
				history: [{ id: 'u1', type: 'message', role: 'user', content: 'Again.' }],
				status: { state: 'idle' }
			}
		])
	})

	test('flattens projected batches into individual item messages', () => {
		const image = { src: '/pictures/fox.png', mimeType: 'image/png' }
		const update: SessionUpdate = {
			type: 'items',
			items: [
				entry('activity-1', {
					type: 'activity',
					items: [{ kind: 'tool', name: 'image', label: 'Made image', durationMs: 200 }],
					images: [image]
				})
			]
		}

		expect(updateMessages(update)).toEqual([
			{
				type: 'item',
				item: {
					id: 'activity-1',
					type: 'activity',
					label: 'Made image · 0.2s',
					items: [{ kind: 'tool', name: 'image', label: 'Made image', durationMs: 200 }]
				}
			},
			{
				type: 'item',
				item: { id: 'activity-1:image:0', type: 'image', image }
			}
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

describe('sessionEntriesToTranscriptItems', () => {
	test('projects receipts, stable images, failures and specialised labels', () => {
		const image = { src: '/pictures/fox.png', mimeType: 'image/png' }
		const projected = sessionEntriesToTranscriptItems([
			entry('thought', {
				type: 'activity',
				items: [{ kind: 'think', durationMs: 8400 }],
				detailId: 'detail-1'
			}),
			entry('tools', {
				type: 'activity',
				items: [
					{ kind: 'tool', name: 'read', label: 'Read file', durationMs: 200 },
					{
						kind: 'tool',
						name: 'test',
						label: 'Ran tests',
						durationMs: 7200,
						failed: true
					}
				],
				images: [image]
			})
		])

		expect(projected).toEqual([
			{
				id: 'thought',
				type: 'activity',
				label: 'Thought for 8.4s',
				items: [{ kind: 'think', durationMs: 8400 }],
				detailId: 'detail-1'
			},
			{
				id: 'tools',
				type: 'activity',
				label: '2 steps · 7.4s',
				items: [
					{ kind: 'tool', name: 'read', label: 'Read file', durationMs: 200 },
					{
						kind: 'tool',
						name: 'test',
						label: 'Ran tests',
						durationMs: 7200,
						failed: true
					}
				],
				failed: true
			},
			{ id: 'tools:image:0', type: 'image', image }
		])
	})

	test('projects ask_user and notes as responses and interior activity', () => {
		const projected = sessionEntriesToTranscriptItems([
			entry('ask', {
				type: 'message',
				role: 'tool_call',
				tool_name: 'ask_user',
				input: { question: 'Tea or coffee?', options: ['Tea', 'Coffee'] }
			}),
			entry('ask-result', {
				type: 'message',
				role: 'tool_result',
				tool_name: 'ask_user',
				content: 'Tea'
			}),
			entry('compact', {
				type: 'compaction',
				summary: 'Earlier work.',
				firstKeptEntryId: 'ask',
				tokensBefore: 4000
			}),
			entry('branch', {
				type: 'branch_summary',
				fromId: 'ask',
				summary: 'Tried another route.'
			}),
			entry('label', { type: 'label', label: 'Before refactor' })
		])

		expect(projected).toEqual([
			{
				id: 'ask',
				type: 'message',
				role: 'assistant',
				content: 'Tea or coffee?',
				options: [{ label: 'Tea' }, { label: 'Coffee' }]
			},
			{
				id: 'compact',
				type: 'activity',
				label: 'Compacted 4000 tokens',
				items: [{ kind: 'note', label: 'Compacted 4000 tokens', body: 'Earlier work.' }]
			},
			{
				id: 'branch',
				type: 'activity',
				label: 'Summarized branch',
				items: [{ kind: 'note', label: 'Summarized branch', body: 'Tried another route.' }]
			},
			{
				id: 'label',
				type: 'activity',
				label: 'Before refactor',
				items: [{ kind: 'note', label: 'Before refactor' }]
			}
		])
	})

	test('groups repeated legacy tools and interleaved thinking in order', () => {
		const entries = [
			entry('think-1', {
				type: 'message',
				role: 'assistant_thinking',
				content: 'First thought.'
			}),
			entry('call-1', {
				type: 'message',
				role: 'tool_call',
				tool_name: 'search',
				input: { query: 'first' }
			}),
			entry('call-2', {
				type: 'message',
				role: 'tool_call',
				tool_name: 'search',
				input: { query: 'second' }
			}),
			entry('result-2', {
				type: 'message',
				role: 'tool_result',
				tool_name: 'search',
				content: '{"match":2}'
			}),
			entry('think-2', {
				type: 'message',
				role: 'assistant_thinking',
				content: 'Second thought.'
			}),
			entry('result-1', {
				type: 'message',
				role: 'tool_result',
				tool_name: 'search',
				content: '{"match":1}'
			})
		]
		const projected = sessionEntriesToTranscriptItems(entries)

		expect(projected).toEqual([
			expect.objectContaining({
				id: 'think-1',
				type: 'activity',
				label: '4 steps · 0.0s',
				detailId: 'legacy:think-1',
				items: [
					{ kind: 'think', durationMs: 0 },
					{ kind: 'tool', name: 'search', label: 'search', durationMs: 0 },
					{ kind: 'tool', name: 'search', label: 'search', durationMs: 0 },
					{ kind: 'think', durationMs: 0 }
				]
			})
		])
		expect(legacyActivityDetail(entries, 'legacy:think-1')).toEqual({
			items: [
				{ kind: 'think', content: 'First thought.' },
				{ kind: 'tool', name: 'search', input: { query: 'first' }, result: { match: 1 } },
				{ kind: 'tool', name: 'search', input: { query: 'second' }, result: { match: 2 } },
				{ kind: 'think', content: 'Second thought.' }
			]
		})
	})

	test('strips expressions only when requested', () => {
		const entries = [
			entry('answer', {
				type: 'message',
				role: 'assistant',
				content: '[pleased]Found it. [concerned]The table is gone.'
			})
		]

		expect(sessionEntriesToTranscriptItems(entries)[0]).toMatchObject({
			content: '[pleased]Found it. [concerned]The table is gone.'
		})
		expect(sessionEntriesToTranscriptItems(entries, { expressions: true })[0]).toMatchObject({
			content: 'Found it. The table is gone.'
		})
	})
})
