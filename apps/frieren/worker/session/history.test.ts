import { describe, it, expect } from 'bun:test'
import { Effect } from 'effect'
import { memStorage } from '@justfiles/fs/storage/mem'
import { volume } from '@justfiles/fs'
import { makeSessionRuntime } from './effect/live.ts'
import {
	loadRecentHistory,
	loadRehydrationMessages,
	projectTranscriptToDisplay,
	startNewSession,
} from './effect/programs.ts'
import { TranscriptStore } from './effect/services.ts'
import type { GenerateText, TranscriptLine } from './types.ts'

const mockGenerate: GenerateText = async () => 'mock'

function setup() {
	const vol = volume(memStorage())
	const runtime = makeSessionRuntime(vol, mockGenerate)
	return { vol, runtime }
}

describe('projectTranscriptToDisplay', () => {
	it('projects a simple user/assistant pair', () => {
		const lines: TranscriptLine[] = [
			{ ts: 't1', role: 'user', content: 'hi' },
			{ ts: 't2', role: 'assistant', content: 'hello' },
		]
		expect(projectTranscriptToDisplay(lines)).toEqual([
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'hello' },
		])
	})

	it('attaches tool calls and results to the preceding assistant message', () => {
		const lines: TranscriptLine[] = [
			{ ts: 't1', role: 'user', content: 'do it' },
			{ ts: 't1.5', role: 'assistant_thinking', content: 'thinking...' },
			{ ts: 't2', role: 'assistant', content: 'on it' },
			{ ts: 't3', role: 'tool_call', tool_name: 'read', input: { path: '/a' } },
			{ ts: 't4', role: 'tool_result', tool_name: 'read', content: 'contents' },
			{ ts: 't5', role: 'assistant', content: ' done' },
		]
		const result = projectTranscriptToDisplay(lines)
		expect(result).toHaveLength(2)
		expect(result[0]).toEqual({ role: 'user', content: 'do it' })
		expect(result[1]!.role).toBe('assistant')
		expect(result[1]!.content).toBe('on it done')
		expect(result[1]!.thinking).toBe('thinking...')
		expect(result[1]!.toolCalls).toEqual([
			{ name: 'read', args: { path: '/a' }, result: 'contents' },
		])
	})

	it('handles a tool call without an assistant text prefix', () => {
		const lines: TranscriptLine[] = [
			{ ts: 't1', role: 'user', content: 'hi' },
			{ ts: 't2', role: 'tool_call', tool_name: 'ls', input: {} },
			{ ts: 't3', role: 'tool_result', tool_name: 'ls', content: 'a\nb' },
		]
		const result = projectTranscriptToDisplay(lines)
		expect(result).toHaveLength(2)
		expect(result[1]).toEqual({
			role: 'assistant',
			content: '',
			toolCalls: [{ name: 'ls', args: {}, result: 'a\nb' }],
		})
	})
})

describe('loadRecentHistory', () => {
	it('returns an empty array when no active session exists', async () => {
		const { runtime } = setup()
		try {
			const history = await runtime.runPromise(loadRecentHistory())
			expect(history).toEqual([])
		} finally {
			await runtime.dispose()
		}
	})

	it('reads the current session transcript and projects it', async () => {
		const { runtime } = setup()
		try {
			const sessionId = await runtime.runPromise(startNewSession())
			const lines: TranscriptLine[] = [
				{ ts: 't1', role: 'user', content: 'hello' },
				{ ts: 't2', role: 'assistant', content: 'hi there' },
			]
			await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (s) => s.append(sessionId, lines)),
			)

			const history = await runtime.runPromise(loadRecentHistory())
			expect(history).toEqual([
				{ role: 'user', content: 'hello' },
				{ role: 'assistant', content: 'hi there' },
			])
		} finally {
			await runtime.dispose()
		}
	})

	it('caps the result to the requested limit', async () => {
		const { runtime } = setup()
		try {
			const sessionId = await runtime.runPromise(startNewSession())
			const lines: TranscriptLine[] = []
			for (let i = 0; i < 10; i++) {
				lines.push({ ts: `t${i}`, role: 'user', content: `q${i}` })
				lines.push({ ts: `t${i}b`, role: 'assistant', content: `a${i}` })
			}
			await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (s) => s.append(sessionId, lines)),
			)

			const history = await runtime.runPromise(loadRecentHistory(4))
			expect(history).toHaveLength(4)
			expect(history[0]).toEqual({ role: 'user', content: 'q8' })
			expect(history[3]).toEqual({ role: 'assistant', content: 'a9' })
		} finally {
			await runtime.dispose()
		}
	})
})

describe('loadRehydrationMessages', () => {
	it('returns text-only user and assistant lines for the session', async () => {
		const { runtime } = setup()
		try {
			const sessionId = await runtime.runPromise(startNewSession())
			const lines: TranscriptLine[] = [
				{ ts: 't1', role: 'user', content: 'hi' },
				{ ts: 't2', role: 'assistant', content: 'hello' },
				{ ts: 't3', role: 'tool_call', tool_name: 'read', input: { path: '/a' } },
				{ ts: 't4', role: 'tool_result', tool_name: 'read', content: 'ok' },
				{ ts: 't5', role: 'assistant', content: 'done' },
			]
			await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (s) => s.append(sessionId, lines)),
			)

			const rehydrated = await runtime.runPromise(loadRehydrationMessages(sessionId))
			expect(rehydrated).toEqual([
				{ role: 'user', content: 'hi' },
				{ role: 'assistant', content: 'hellodone' },
			])
		} finally {
			await runtime.dispose()
		}
	})

	it('coalesces consecutive assistant lines that surround dropped tool calls', async () => {
		const { runtime } = setup()
		try {
			const sessionId = await runtime.runPromise(startNewSession())
			const lines: TranscriptLine[] = [
				{ ts: 't1', role: 'user', content: 'hi' },
				{ ts: 't2', role: 'assistant', content: 'before ' },
				{ ts: 't3', role: 'tool_call', tool_name: 'read', input: {} },
				{ ts: 't4', role: 'tool_result', tool_name: 'read', content: 'ok' },
				{ ts: 't5', role: 'assistant', content: 'after' },
			]
			await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (s) => s.append(sessionId, lines)),
			)

			const rehydrated = await runtime.runPromise(loadRehydrationMessages(sessionId))
			expect(rehydrated).toEqual([
				{ role: 'user', content: 'hi' },
				{ role: 'assistant', content: 'before after' },
			])
		} finally {
			await runtime.dispose()
		}
	})

	it('drops leading assistant messages so the tail starts at a user boundary', async () => {
		const { runtime } = setup()
		try {
			const sessionId = await runtime.runPromise(startNewSession())
			const lines: TranscriptLine[] = [
				{ ts: 't0', role: 'assistant', content: 'stray opener' },
				{ ts: 't1', role: 'user', content: 'hi' },
				{ ts: 't2', role: 'assistant', content: 'hello' },
			]
			await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (s) => s.append(sessionId, lines)),
			)

			const rehydrated = await runtime.runPromise(loadRehydrationMessages(sessionId))
			expect(rehydrated).toEqual([
				{ role: 'user', content: 'hi' },
				{ role: 'assistant', content: 'hello' },
			])
		} finally {
			await runtime.dispose()
		}
	})

	it('drops a trailing orphan user turn so a fresh prompt does not stack on it', async () => {
		const { runtime } = setup()
		try {
			const sessionId = await runtime.runPromise(startNewSession())
			const lines: TranscriptLine[] = [
				{ ts: 't1', role: 'user', content: 'answered question' },
				{ ts: 't2', role: 'assistant', content: 'answered reply' },
				{ ts: 't3', role: 'user', content: 'stale unanswered prompt' },
			]
			await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (s) => s.append(sessionId, lines)),
			)

			const rehydrated = await runtime.runPromise(loadRehydrationMessages(sessionId))
			expect(rehydrated).toEqual([
				{ role: 'user', content: 'answered question' },
				{ role: 'assistant', content: 'answered reply' },
			])
		} finally {
			await runtime.dispose()
		}
	})

	it('keeps whole recent turns inside the token budget', async () => {
		const { runtime } = setup()
		try {
			const sessionId = await runtime.runPromise(startNewSession())
			const lines: TranscriptLine[] = [
				{ ts: 't1a', role: 'user', content: 'a'.repeat(256) },
				{ ts: 't1b', role: 'assistant', content: 'b'.repeat(256) },
				{ ts: 't2a', role: 'user', content: 'c'.repeat(256) },
				{ ts: 't2b', role: 'assistant', content: 'd'.repeat(256) },
				{ ts: 't3a', role: 'user', content: 'e'.repeat(256) },
				{ ts: 't3b', role: 'assistant', content: 'f'.repeat(256) },
			]
			await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (s) => s.append(sessionId, lines)),
			)

			const rehydrated = await runtime.runPromise(
				loadRehydrationMessages(sessionId, {
					contextTokenBudget: 300,
					responseReserveTokens: 0,
				}),
			)
			expect(rehydrated).toHaveLength(4)
			expect(rehydrated[0]).toEqual({ role: 'user', content: 'c'.repeat(256) })
			expect(rehydrated[3]).toEqual({ role: 'assistant', content: 'f'.repeat(256) })
		} finally {
			await runtime.dispose()
		}
	})
})
