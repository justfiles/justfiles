import type { StreamFn } from '@earendil-works/pi-agent-core'
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model
} from '@earendil-works/pi-ai'
import { volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { describe, expect, test } from 'vitest'
import type { AgentBackend } from './llm.ts'
import { createAgentSession, type SessionEvent } from './session.ts'

const encoder = new TextEncoder()

// A full AssistantMessage with the given content blocks. `stopReason`/`errorMessage` are
// overridable so a test can script an error turn or a tool-call turn.
function assistant(
	content: AssistantMessage['content'],
	over: Partial<AssistantMessage> = {}
): AssistantMessage {
	return {
		role: 'assistant',
		content,
		api: 'test',
		provider: 'test',
		model: 'test',
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
		},
		stopReason: 'stop',
		timestamp: Date.now(),
		...over
	}
}

// A credential-sealed backend whose stream returns the scripted assistant messages one per
// turn-step (so a tool-call message + a follow-up text message drive a full ask_user turn).
// `complete` backs the text helper (compaction notes / memory consolidation).
function scriptedBackend(messages: AssistantMessage[], complete = ''): AgentBackend {
	const queue = [...messages]
	const streamFn: StreamFn = () => {
		const stream = createAssistantMessageEventStream()
		const message = queue.shift() ?? assistant([])
		stream.push({ type: 'done', reason: 'stop', message })
		stream.end(message)
		return stream
	}
	const completeFn: AgentBackend['completeFn'] = async () =>
		assistant(complete ? [{ type: 'text', text: complete }] : [])
	return {
		model: { id: 'test' } as Model<Api>,
		streamFn,
		completeFn,
		revision: 'r1'
	}
}

const NO_COMPACTION = { enabled: false, reserveTokens: 0, keepRecentTokens: 0 }

describe('createAgentSession', () => {
	test('runs a turn: broadcasts busy + transcript and returns the answer', async () => {
		const events: SessionEvent[] = []
		const session = createAgentSession({
			volume: volume(memStorage()),
			backend: scriptedBackend([assistant([{ type: 'text', text: 'Hi there' }])]),
			compaction: NO_COMPACTION
		})
		session.subscribe((event) => events.push(event))

		await expect(session.prompt('hello')).resolves.toBe('Hi there')

		expect(events.map((event) => event.type)).toEqual(['busy', 'transcript', 'busy'])
		expect(events[0]).toEqual({ type: 'busy', value: true })
		expect(events.at(-1)).toEqual({ type: 'busy', value: false })
		const transcript = events.find((event) => event.type === 'transcript')
		expect(transcript?.type === 'transcript' && transcript.entries).toMatchObject([
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: 'Hi there' }
		])
	})

	test('an ask_user turn pings a question notification', async () => {
		const notifications: { kind: string; body: string; route?: unknown }[] = []
		const session = createAgentSession({
			volume: volume(memStorage()),
			backend: scriptedBackend([
				assistant([
					{
						type: 'toolCall',
						id: 't1',
						name: 'ask_user',
						arguments: { question: 'Tea or coffee?', options: ['tea', 'coffee'] }
					}
				]),
				assistant([{ type: 'text', text: 'waiting' }])
			]),
			compaction: NO_COMPACTION,
			notify: (n) => notifications.push({ kind: n.kind, body: n.body, route: n.route })
		})

		await session.prompt('help me choose')

		expect(notifications).toHaveLength(1)
		expect(notifications[0]).toMatchObject({ kind: 'question', body: 'Tea or coffee?' })
	})

	test('a classified failure emits an error event routed to Accounts', async () => {
		const events: SessionEvent[] = []
		const notifications: { kind: string }[] = []
		const session = createAgentSession({
			volume: volume(memStorage()),
			backend: scriptedBackend([
				assistant([], { stopReason: 'error', errorMessage: '401 Unauthorized' })
			]),
			compaction: NO_COMPACTION,
			notify: (n) => notifications.push({ kind: n.kind })
		})
		session.subscribe((event) => events.push(event))

		await expect(session.prompt('hello')).resolves.toBe('')

		const error = events.find((event) => event.type === 'error')
		expect(error?.type === 'error' && error.route).toEqual({ kind: 'settings', pane: 'accounts' })
		expect(notifications).toEqual([{ kind: 'error' }])
	})

	test('newSession clears the transcript', async () => {
		const vol = volume(memStorage())
		const session = createAgentSession({
			volume: vol,
			backend: scriptedBackend([assistant([{ type: 'text', text: 'first' }])]),
			compaction: NO_COMPACTION
		})
		await session.prompt('hello')
		expect((await session.history()).length).toBeGreaterThan(0)

		const events: SessionEvent[] = []
		session.subscribe((event) => events.push(event))
		await session.newSession()

		expect(events).toContainEqual({ type: 'transcript', entries: [] })
		expect(await session.history()).toEqual([])
	})

	test('applySkill loads a Volume skill and runs it as a turn', async () => {
		const vol = volume(memStorage())
		await vol.mkdir('/system/skills', { recursive: true })
		await vol.writeFile(
			'/system/skills/greet.md',
			encoder.encode('---\nname: Greet\ndescription: say hi\n---\nGreet the user warmly.')
		)
		const session = createAgentSession({
			volume: vol,
			backend: scriptedBackend([assistant([{ type: 'text', text: 'Hello!' }])]),
			compaction: NO_COMPACTION
		})

		expect((await session.listSkills()).map((skill) => skill.id)).toEqual(['greet'])
		await expect(session.applySkill('greet')).resolves.toBe('Hello!')
	})

	test('runMaintenance consolidates yesterday notes into memory', async () => {
		const vol = volume(memStorage())
		const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
		await vol.mkdir('/system/memory/daily', { recursive: true })
		await vol.writeFile(`/system/memory/daily/${yesterday}.md`, encoder.encode('- user likes tea'))
		const session = createAgentSession({
			volume: vol,
			backend: scriptedBackend([], 'user prefers tea'),
			compaction: NO_COMPACTION
		})

		await session.runMaintenance()

		const memory = new TextDecoder().decode(await vol.readFile('/system/memory/core.md'))
		expect(memory).toContain('user prefers tea')
	})

	test('nextMaintenanceAt returns 4am in the configured timezone', async () => {
		const session = createAgentSession({
			volume: volume(memStorage()),
			backend: scriptedBackend([]),
			timezone: () => 'UTC'
		})
		const now = new Date('2026-07-05T10:00:00Z')
		const at = await session.nextMaintenanceAt(now)
		// 4am UTC has passed at 10:00, so it schedules the next day's 4am.
		expect(at).toBe(new Date('2026-07-06T04:00:00Z').getTime())
	})
})
