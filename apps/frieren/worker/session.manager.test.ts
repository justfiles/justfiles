import { describe, test, expect } from 'bun:test'
import { volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { session, type CompactionEntry, type ContextMessage, type MessagePayload, type SessionEntry } from './session.manager.ts'
import type { GenerateText } from './llm.text.ts'

function user(content: string): MessagePayload {
	return { type: 'message', role: 'user', content }
}

function assistant(content: string): MessagePayload {
	return { type: 'message', role: 'assistant', content }
}

function toolCall(tool_name: string, input: Record<string, unknown>): MessagePayload {
	return { type: 'message', role: 'tool_call', tool_name, input }
}

function toolResult(tool_name: string, content: string): MessagePayload {
	return { type: 'message', role: 'tool_result', tool_name, content }
}

function longText(label: string, count = 220): string {
	return Array.from({ length: count }, (_, i) => `${label} ${i}`).join(' ')
}

async function makeManager(generateText: GenerateText = async () => 'summary') {
	const vol = volume(memStorage())
	return session(`/agents/test/sessions/${crypto.randomUUID()}.jsonl`, vol, generateText)
}

function stripContext(context: ReadonlyArray<ContextMessage>) {
	return context.map(({ role, content }) => ({ role, content }))
}

function lastCompaction(entries: ReadonlyArray<SessionEntry>): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]
		if (entry?.type === 'compaction') return entry
	}
	return null
}

function expectedVisibleContext(entries: ReadonlyArray<SessionEntry>) {
	const compaction = lastCompaction(entries)
	const startIndex = compaction
		? entries.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
		: 0
	const visibleEntries = startIndex >= 0 ? entries.slice(startIndex) : entries
	const context = visibleEntries.flatMap((entry) => {
		if (entry.type !== 'message') return []
		if (entry.role !== 'user' && entry.role !== 'assistant') return []
		return [{ role: entry.role, content: entry.content }]
	})

	return compaction
		? [{ role: 'assistant' as const, content: compaction.summary }, ...context]
		: context
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
			assistant('Happy to help. What kind of trip are you after?'),
		])
		expect(first.compacted).toBe(false)
		const firstLeafId = manager.activeLeafId

		const second = await manager.append([
			user('Find a quiet ryokan with a private bath.'),
			toolCall('search_hotels', { city: 'Kyoto', bath: true }),
			toolResult('search_hotels', 'Three matching ryokans found.'),
			assistant('I found three ryokans that fit that request.'),
		])
		expect(second.compacted).toBe(false)

		const branch = await manager.walkActiveBranch()
		expect(branch).toHaveLength(6)
		expectSequentialBranch(branch)
		expect(firstLeafId).toBe(branch[1]?.id)
		expect(manager.activeLeafId).toBe(branch[5]?.id)

		expect(branch.map((entry) => entry.type === 'message' ? entry.role : entry.type)).toEqual([
			'user',
			'assistant',
			'user',
			'tool_call',
			'tool_result',
			'assistant',
		])

		const context = await manager.buildSessionContext()
		expect(stripContext(context)).toEqual([
			{ role: 'user', content: 'I need help planning a Kyoto trip.' },
			{ role: 'assistant', content: 'Happy to help. What kind of trip are you after?' },
			{ role: 'user', content: 'Find a quiet ryokan with a private bath.' },
			{ role: 'assistant', content: 'I found three ryokans that fit that request.' },
		])
		expect(context.every((message) => Number.isFinite(message.timestamp))).toBe(true)
	})

	test('compaction preserves full branch history while shrinking model-visible context', async () => {
		const manager = await makeManager(async () => 'Summary: Kyoto trip preferences and shortlist so far.')

		await manager.append([
			user(longText('User shares trip constraints')),
			assistant(longText('Assistant proposes a first itinerary')),
			user(longText('User asks for quieter neighborhoods and bath options')),
			assistant(longText('Assistant revises the shortlist with tradeoffs')),
		], { contextBudget: 1_000_000 })

		const result = await manager.append([
			user('Turn all of that into a packing checklist.'),
		], {
			contextBudget: 120,
			systemPromptTokens: 80,
		})

		expect(result.compacted).toBe(true)

		const branch = await manager.walkActiveBranch()
		const compaction = lastCompaction(branch)
		expect(compaction).not.toBeNull()
		expect(compaction?.summary).toBe('Summary: Kyoto trip preferences and shortlist so far.')
		expect(branch.filter((entry) => entry.type === 'compaction')).toHaveLength(1)
		expect(branch.some((entry) => entry.type === 'message' && entry.role === 'user' && entry.content.includes('trip constraints'))).toBe(true)

		const context = await manager.buildSessionContext()
		expect(stripContext(context)).toEqual(expectedVisibleContext(branch))
		expect(context[0]?.role).toBe('assistant')
		expect(context[0]?.content).toBe('Summary: Kyoto trip preferences and shortlist so far.')
		expect(context.every((message) => Number.isFinite(message.timestamp))).toBe(true)
	})

	test('only the last compaction summary anchors the final model context after repeated growth', async () => {
		let callCount = 0
		const manager = await makeManager(async () => {
			callCount += 1
			return callCount === 1
				? 'Summary one: budget, bath preference, and neighborhood shortlist.'
				: 'Summary two: narrowed down to two ryokans and a packing plan.'
		})

		await manager.append([
			user(longText('First planning turn')),
			assistant(longText('First planning reply')),
			user(longText('Second planning turn')),
			assistant(longText('Second planning reply')),
		], { contextBudget: 1_000_000 })

		expect((await manager.append([
			user('Now condense the planning into next steps.'),
		], {
			contextBudget: 120,
			systemPromptTokens: 80,
		})).compacted).toBe(true)

		await manager.append([
			user(longText('Follow-up on train passes and weather')),
			assistant(longText('Advice on rail passes, rain gear, and luggage')),
			user(longText('Final questions about bathing etiquette and check-in timing')),
			assistant(longText('Guidance on etiquette, arrival windows, and reminders')),
		], { contextBudget: 1_000_000 })

		expect((await manager.append([
			user('Give me the final trip brief I can share with my partner.'),
		], {
			contextBudget: 120,
			systemPromptTokens: 80,
		})).compacted).toBe(true)

		const branch = await manager.walkActiveBranch()
		const compactions = branch.filter((entry): entry is CompactionEntry => entry.type === 'compaction')
		expect(compactions).toHaveLength(2)
		expect(compactions[0]?.summary).toBe('Summary one: budget, bath preference, and neighborhood shortlist.')
		expect(compactions[1]?.summary).toBe('Summary two: narrowed down to two ryokans and a packing plan.')

		const context = await manager.buildSessionContext()
		expect(stripContext(context)).toEqual(expectedVisibleContext(branch))
		expect(context[0]?.content).toBe('Summary two: narrowed down to two ryokans and a packing plan.')
		expect(context.some((message) => message.content === 'Summary one: budget, bath preference, and neighborhood shortlist.')).toBe(false)
	})
})
