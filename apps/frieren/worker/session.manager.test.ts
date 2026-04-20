import { describe, expect, test } from 'bun:test'
import { volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import {
	type AppendPayload,
	type ContextMessage,
	type SessionEntry,
	session
} from './session.manager.ts'

function user(content: string): AppendPayload {
	return { type: 'message', role: 'user', content }
}

function assistant(content: string): AppendPayload {
	return { type: 'message', role: 'assistant', content }
}

function toolCall(tool_name: string, input: Record<string, unknown>): AppendPayload {
	return { type: 'message', role: 'tool_call', tool_name, input }
}

function toolResult(tool_name: string, content: string): AppendPayload {
	return { type: 'message', role: 'tool_result', tool_name, content }
}

function compactionPayload(summary: string, firstKeptEntryId: string): AppendPayload {
	return {
		type: 'compaction',
		summary,
		firstKeptEntryId,
		tokensBefore: 42
	}
}

async function makeManager() {
	const vol = volume(memStorage())
	return session(`/agents/test/sessions/${crypto.randomUUID()}.jsonl`, vol)
}

function stripContext(context: ReadonlyArray<ContextMessage>) {
	return context.map(({ role, content }) => ({ role, content }))
}

function expectSequentialBranch(entries: ReadonlyArray<SessionEntry>) {
	expect(entries[0]?.parentId ?? null).toBeNull()
	for (let i = 1; i < entries.length; i++) {
		expect(entries[i]?.parentId).toBe(entries[i - 1]?.id)
	}
}

describe('session manager', () => {
	test('appends along the active leaf and projects tool-heavy history into plain context', async () => {
		const manager = await makeManager()

		expect(manager.activeLeafId).toBeNull()
		expect(await manager.buildSessionContext()).toEqual([])

		const first = await manager.append([
			user('I need help planning a Kyoto trip.'),
			assistant('Happy to help. What kind of trip are you after?')
		])
		expect(first.compacted).toBe(false)
		const firstLeafId = manager.activeLeafId

		const second = await manager.append([
			user('Find a quiet ryokan with a private bath.'),
			toolCall('search_hotels', { city: 'Kyoto', bath: true }),
			toolResult('search_hotels', 'Three matching ryokans found.'),
			assistant('I found three ryokans that fit that request.')
		])
		expect(second.compacted).toBe(false)

		const branch = await manager.walkActiveBranch()
		expect(branch).toHaveLength(6)
		expectSequentialBranch(branch)
		expect(firstLeafId).toBe(branch[1]?.id)
		expect(manager.activeLeafId).toBe(branch[5]?.id)

		expect(branch.map((entry) => (entry.type === 'message' ? entry.role : entry.type))).toEqual([
			'user',
			'assistant',
			'user',
			'tool_call',
			'tool_result',
			'assistant'
		])

		const context = await manager.buildSessionContext()
		expect(stripContext(context)).toEqual([
			{ role: 'user', content: 'I need help planning a Kyoto trip.' },
			{ role: 'assistant', content: 'Happy to help. What kind of trip are you after?' },
			{ role: 'user', content: 'Find a quiet ryokan with a private bath.' },
			{ role: 'assistant', content: 'I found three ryokans that fit that request.' }
		])
		expect(context.every((message) => Number.isFinite(message.timestamp))).toBe(true)
	})

	test('accepts explicit compaction payloads in append', async () => {
		const manager = await makeManager()

		await manager.append([user('Original question'), assistant('Original answer')])

		const branchBefore = await manager.walkActiveBranch()
		const firstKeptEntryId = branchBefore[1]?.id
		expect(firstKeptEntryId).toBeDefined()
		if (!firstKeptEntryId) {
			throw new Error('expected the second branch entry to exist')
		}

		await manager.append([
			compactionPayload('Summary of the original exchange.', firstKeptEntryId),
			user('Follow-up question'),
			assistant('Follow-up answer')
		])

		const branch = await manager.walkActiveBranch()
		expect(branch.map((entry) => (entry.type === 'message' ? entry.role : entry.type))).toEqual([
			'user',
			'assistant',
			'compaction',
			'user',
			'assistant'
		])

		const context = await manager.buildSessionContext()
		expect(stripContext(context)).toEqual([
			{ role: 'assistant', content: 'Summary of the original exchange.' },
			{ role: 'assistant', content: 'Original answer' },
			{ role: 'user', content: 'Follow-up question' },
			{ role: 'assistant', content: 'Follow-up answer' }
		])
	})
})
