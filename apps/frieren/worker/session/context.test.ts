import { describe, test, expect } from 'bun:test'
import { memStorage } from '@justfiles/fs/storage/mem'
import { volume } from '@justfiles/fs'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { Message } from '@mariozechner/pi-ai'
import { windowMessages } from './context.ts'
import { makeSessionRuntime } from './effect/live.ts'
import { buildSystemPrompt } from './effect/programs.ts'
import { PATHS } from './types.ts'
import type { GenerateText } from './types.ts'

const enc = new TextEncoder()
const mockGenerate: GenerateText = async (_sys, _user) => 'placeholder'

function userMsg(text: string): Message {
	return { role: 'user', content: text, timestamp: Date.now() }
}

function assistantMsg(text: string): AgentMessage {
	return { role: 'assistant', content: [{ type: 'text', text }] } as unknown as AgentMessage
}

function testSetup() {
	const vol = volume(memStorage())
	const runtime = makeSessionRuntime(vol, mockGenerate)
	return { vol, runtime }
}

describe('windowMessages', () => {
	test('returns empty array for empty input', () => {
		expect(windowMessages([], 20)).toEqual([])
	})

	test('returns all messages when fewer than maxTurns user messages', () => {
		const msgs: AgentMessage[] = [
			userMsg('hi'),
			assistantMsg('hello'),
			userMsg('how are you'),
			assistantMsg('fine'),
		]
		expect(windowMessages(msgs, 20)).toEqual(msgs)
	})

	test('keeps last N user turns and their responses', () => {
		const msgs: AgentMessage[] = [
			userMsg('turn 1'),
			assistantMsg('reply 1'),
			userMsg('turn 2'),
			assistantMsg('reply 2'),
			userMsg('turn 3'),
			assistantMsg('reply 3'),
		]
		const result = windowMessages(msgs, 2)
		expect(result.length).toBe(4)
		expect((result[0] as Message).content).toBe('turn 2')
		expect(result[3]).toBe(msgs[5])
	})

	test('window to 1 keeps only the last user turn', () => {
		const msgs: AgentMessage[] = [
			userMsg('old'),
			assistantMsg('old reply'),
			userMsg('recent'),
			assistantMsg('recent reply'),
		]
		const result = windowMessages(msgs, 1)
		expect(result.length).toBe(2)
		expect((result[0] as Message).content).toBe('recent')
	})

	test('preserves tool results between user and assistant messages', () => {
		const toolResult = {
			role: 'toolResult',
			content: [{ type: 'text', text: 'file contents' }],
			toolCallId: 'tc1',
			timestamp: Date.now(),
		} as unknown as AgentMessage
		const msgs: AgentMessage[] = [
			userMsg('old turn'),
			assistantMsg('old reply'),
			userMsg('read the file'),
			assistantMsg('let me read it'),
			toolResult,
			assistantMsg('here are the contents'),
		]
		const result = windowMessages(msgs, 1)
		expect(result.length).toBe(4)
		expect((result[0] as Message).content).toBe('read the file')
	})

	test('handles messages with no user messages', () => {
		const msgs: AgentMessage[] = [assistantMsg('system init')]
		expect(windowMessages(msgs, 20)).toEqual(msgs)
	})
})

describe('effect buildSystemPrompt', () => {
	test('returns setup prompt when soul.md is missing', async () => {
		const { runtime } = testSetup()
		try {
			const prompt = await runtime.runPromise(
				buildSystemPrompt({
					currentSessionId: null,
					isNewSession: false,
					latestHandoffPath: null,
				}),
			)
			expect(prompt).toContain('first-time setup')
		} finally {
			await runtime.dispose()
		}
	})

	test('returns soul.md content as base', async () => {
		const { vol, runtime } = testSetup()
		try {
			await vol.writeFile(PATHS.soul, enc.encode('You are Frieren.'))
			const prompt = await runtime.runPromise(
				buildSystemPrompt({
					currentSessionId: null,
					isNewSession: false,
					latestHandoffPath: null,
				}),
			)
			expect(prompt).toContain('You are Frieren.')
			expect(prompt).toContain('Persistent memory')
		} finally {
			await runtime.dispose()
		}
	})

	test('appends profile when present', async () => {
		const { vol, runtime } = testSetup()
		try {
			await vol.writeFile(PATHS.soul, enc.encode('You are Frieren.'))
			await vol.mkdir('/profiles', { recursive: true })
			await vol.writeFile(PATHS.profile, enc.encode('# Profile: alice'))

			const prompt = await runtime.runPromise(
				buildSystemPrompt({
					currentSessionId: null,
					isNewSession: false,
					latestHandoffPath: null,
				}),
			)
			expect(prompt).toContain('You are Frieren.')
			expect(prompt).toContain('# Profile: alice')
			expect(prompt).toContain('\n\n---\n\n')
		} finally {
			await runtime.dispose()
		}
	})

	test('loads handoff for new session', async () => {
		const { vol, runtime } = testSetup()
		try {
			await vol.writeFile(PATHS.soul, enc.encode('You are Frieren.'))
			const handoffPath = '/sessions/archive/test-session/handoff.md'
			await vol.mkdir('/sessions/archive/test-session', { recursive: true })
			await vol.writeFile(handoffPath, enc.encode('# Handoff\nWe were discussing elves.'))

			const prompt = await runtime.runPromise(
				buildSystemPrompt({
					currentSessionId: 'new-session-id',
					isNewSession: true,
					latestHandoffPath: handoffPath,
				}),
			)
			expect(prompt).toContain('You are Frieren.')
			expect(prompt).toContain('We were discussing elves.')
		} finally {
			await runtime.dispose()
		}
	})

	test('loads rolling summary for resumed session', async () => {
		const { vol, runtime } = testSetup()
		try {
			await vol.writeFile(PATHS.soul, enc.encode('You are Frieren.'))

			const sessionId = 'test-session'
			await vol.mkdir(PATHS.activeSession(sessionId), { recursive: true })
			await vol.writeFile(
				PATHS.rollingSummary(sessionId),
				enc.encode('# Rolling Summary\nDiscussing magic theory.'),
			)

			const prompt = await runtime.runPromise(
				buildSystemPrompt({
					currentSessionId: sessionId,
					isNewSession: false,
					latestHandoffPath: null,
				}),
			)
			expect(prompt).toContain('You are Frieren.')
			expect(prompt).toContain('Discussing magic theory.')
		} finally {
			await runtime.dispose()
		}
	})

	test('skips handoff when isNewSession is false even if path is set', async () => {
		const { vol, runtime } = testSetup()
		try {
			await vol.writeFile(PATHS.soul, enc.encode('You are Frieren.'))
			const handoffPath = '/sessions/archive/old/handoff.md'
			await vol.mkdir('/sessions/archive/old', { recursive: true })
			await vol.writeFile(handoffPath, enc.encode('old handoff'))

			const prompt = await runtime.runPromise(
				buildSystemPrompt({
					currentSessionId: 'current',
					isNewSession: false,
					latestHandoffPath: handoffPath,
				}),
			)
			expect(prompt).not.toContain('old handoff')
		} finally {
			await runtime.dispose()
		}
	})

	test('skips handoff when latestHandoffPath is null on new session', async () => {
		const { vol, runtime } = testSetup()
		try {
			await vol.writeFile(PATHS.soul, enc.encode('You are Frieren.'))

			const prompt = await runtime.runPromise(
				buildSystemPrompt({
					currentSessionId: 'first-session',
					isNewSession: true,
					latestHandoffPath: null,
				}),
			)
			expect(prompt).toContain('You are Frieren.')
		} finally {
			await runtime.dispose()
		}
	})

	test('gracefully handles missing rolling summary', async () => {
		const { vol, runtime } = testSetup()
		try {
			await vol.writeFile(PATHS.soul, enc.encode('You are Frieren.'))

			const prompt = await runtime.runPromise(
				buildSystemPrompt({
					currentSessionId: 'no-summary-yet',
					isNewSession: false,
					latestHandoffPath: null,
				}),
			)
			expect(prompt).toContain('You are Frieren.')
		} finally {
			await runtime.dispose()
		}
	})
})
