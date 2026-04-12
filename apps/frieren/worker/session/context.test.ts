/**
 * Tests for Phase 2: transformContext wiring.
 *
 * Tests the two exported pure functions:
 * - windowMessages: context windowing by user turn count
 * - buildSystemPrompt: dynamic system prompt assembly from session files
 */
import { describe, test, expect } from 'bun:test'
import { memStorage } from '@justfiles/fs/storage/mem'
import { volume } from '@justfiles/fs'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { Message } from '@mariozechner/pi-ai'
import { windowMessages, buildSystemPrompt } from './context.ts'
import { createSessionManager } from './manager.ts'
import { createTranscriptWriter } from './transcript.ts'
import { PATHS } from './types.ts'

const enc = new TextEncoder()

function userMsg(text: string): Message {
	return { role: 'user', content: text, timestamp: Date.now() }
}

function assistantMsg(text: string): AgentMessage {
	// Minimal assistant-shaped message for windowing tests.
	// Only the role field matters for windowMessages.
	return { role: 'assistant', content: [{ type: 'text', text }] } as unknown as AgentMessage
}

function testSetup() {
	const vol = volume(memStorage())
	const tw = createTranscriptWriter(vol)
	const mockGenerate = async () => 'placeholder'
	const sm = createSessionManager(vol, tw, mockGenerate)
	return { vol, sm }
}

// ── windowMessages ──────────────────────────────────────────────────────

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
		const result = windowMessages(msgs, 20)
		expect(result).toEqual(msgs)
	})

	test('keeps last N user turns and their responses', () => {
		// 3 user turns, window to 2
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
		// Should keep everything from 'read the file' onwards
		expect(result.length).toBe(4)
		expect((result[0] as Message).content).toBe('read the file')
	})

	test('handles messages with no user messages', () => {
		const msgs: AgentMessage[] = [
			assistantMsg('system init'),
		]
		const result = windowMessages(msgs, 20)
		// cutoff stays at 0, returns everything
		expect(result).toEqual(msgs)
	})
})

// ── buildSystemPrompt ───────────────────────────────────────────────────

describe('buildSystemPrompt', () => {
	test('returns setup prompt when soul.md is missing', async () => {
		const { sm } = testSetup()
		const prompt = await buildSystemPrompt(sm, {
			currentSessionId: null,
			isNewSession: false,
			latestHandoffPath: null,
		})
		expect(prompt).toContain('first-time setup')
	})

	test('returns soul.md content as base', async () => {
		const { vol, sm } = testSetup()
		await vol.writeFile(PATHS.soul, enc.encode('You are Frieren.'))

		const prompt = await buildSystemPrompt(sm, {
			currentSessionId: null,
			isNewSession: false,
			latestHandoffPath: null,
		})
		expect(prompt).toContain('You are Frieren.')
		expect(prompt).toContain('Persistent memory')
	})

	test('appends profile when present', async () => {
		const { vol, sm } = testSetup()
		await vol.writeFile(PATHS.soul, enc.encode('You are Frieren.'))
		await vol.mkdir('/profiles', { recursive: true })
		await vol.writeFile(PATHS.profile, enc.encode('# Profile: alice'))

		const prompt = await buildSystemPrompt(sm, {
			currentSessionId: null,
			isNewSession: false,
			latestHandoffPath: null,
		})
		expect(prompt).toContain('You are Frieren.')
		expect(prompt).toContain('# Profile: alice')
		expect(prompt).toContain('\n\n---\n\n')
	})

	test('loads handoff for new session', async () => {
		const { vol, sm } = testSetup()
		await vol.writeFile(PATHS.soul, enc.encode('You are Frieren.'))
		const handoffPath = '/sessions/archive/test-session/handoff.md'
		await vol.mkdir('/sessions/archive/test-session', { recursive: true })
		await vol.writeFile(handoffPath, enc.encode('# Handoff\nWe were discussing elves.'))

		const prompt = await buildSystemPrompt(sm, {
			currentSessionId: 'new-session-id',
			isNewSession: true,
			latestHandoffPath: handoffPath,
		})
		expect(prompt).toContain('You are Frieren.')
		expect(prompt).toContain('We were discussing elves.')
	})

	test('loads rolling summary for resumed session', async () => {
		const { vol, sm } = testSetup()
		await vol.writeFile(PATHS.soul, enc.encode('You are Frieren.'))

		const sessionId = 'test-session'
		await vol.mkdir(PATHS.activeSession(sessionId), { recursive: true })
		await vol.writeFile(
			PATHS.rollingSummary(sessionId),
			enc.encode('# Rolling Summary\nDiscussing magic theory.'),
		)

		const prompt = await buildSystemPrompt(sm, {
			currentSessionId: sessionId,
			isNewSession: false,
			latestHandoffPath: null,
		})
		expect(prompt).toContain('You are Frieren.')
		expect(prompt).toContain('Discussing magic theory.')
	})

	test('skips handoff when isNewSession is false even if path is set', async () => {
		const { vol, sm } = testSetup()
		await vol.writeFile(PATHS.soul, enc.encode('You are Frieren.'))
		const handoffPath = '/sessions/archive/old/handoff.md'
		await vol.mkdir('/sessions/archive/old', { recursive: true })
		await vol.writeFile(handoffPath, enc.encode('old handoff'))

		const prompt = await buildSystemPrompt(sm, {
			currentSessionId: 'current',
			isNewSession: false,
			latestHandoffPath: handoffPath,
		})
		expect(prompt).not.toContain('old handoff')
	})

	test('skips handoff when latestHandoffPath is null on new session', async () => {
		const { vol, sm } = testSetup()
		await vol.writeFile(PATHS.soul, enc.encode('You are Frieren.'))

		const prompt = await buildSystemPrompt(sm, {
			currentSessionId: 'first-session',
			isNewSession: true,
			latestHandoffPath: null,
		})
		expect(prompt).toContain('You are Frieren.')
	})

	test('gracefully handles missing rolling summary', async () => {
		const { vol, sm } = testSetup()
		await vol.writeFile(PATHS.soul, enc.encode('You are Frieren.'))

		const prompt = await buildSystemPrompt(sm, {
			currentSessionId: 'no-summary-yet',
			isNewSession: false,
			latestHandoffPath: null,
		})
		expect(prompt).toContain('You are Frieren.')
	})
})
