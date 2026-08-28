import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import { type AssistantMessage, createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { type Volume, volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import Type from 'typebox'
import { describe, expect, test, vi } from 'vitest'
import { createActivityRecorder } from './activity.ts'
import { createAssistant } from './assistant.ts'
import type { LLMText } from './llm.text.ts'
import { filesystemPrompt, systemPrompt } from './prompts.ts'
import { ActivityDetailSchema, type ActivityRunEntry } from './session.manager.ts'

const encoder = new TextEncoder()
const MAIN = { agentId: 'main', kind: 'main' } as const

function testTool(name: string): AgentTool {
	const parameters = Type.Object({})
	return {
		name,
		label: name,
		description: name,
		parameters,
		async execute() {
			return { content: [{ type: 'text', text: 'ok' }], details: null }
		}
	} satisfies AgentTool<typeof parameters>
}

function testText(): LLMText {
	return {
		async gen() {
			return ''
		},
		async takeNotes() {
			return undefined
		},
		async summarise() {
			return ''
		}
	} as LLMText
}

function assistant(content: AssistantMessage['content']): AssistantMessage {
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
		timestamp: Date.now()
	}
}

function scriptedAgent(messages: AssistantMessage[]): Agent {
	return new Agent({
		streamFn: () => {
			const stream = createAssistantMessageEventStream()
			const message = messages.shift() ?? assistant([])
			stream.push({ type: 'done', reason: 'stop', message })
			stream.end(message)
			return stream
		}
	})
}

async function readDetail(vol: Volume, entry: ActivityRunEntry) {
	const sessions = await vol.readdir('/private/cache/agent-activity/main')
	const session = sessions[0]
	if (!session || !entry.detailId) throw new Error('expected an activity detail')
	const raw = await vol.readFile(
		`/private/cache/agent-activity/main/${session.name}/${entry.detailId}.json`
	)
	return ActivityDetailSchema.parse(JSON.parse(new TextDecoder().decode(raw)))
}

describe('assistant prompt', () => {
	test('records thinking and failed tool durations from agent events', async () => {
		let now = 0
		const recorder = createActivityRecorder(() => now)
		const discarded = assistant([{ type: 'thinking', thinking: 'Discard this.' }])
		recorder.onEvent({ type: 'message_start', message: discarded })
		recorder.onEvent({
			type: 'message_update',
			message: discarded,
			assistantMessageEvent: { type: 'thinking_start', contentIndex: 0, partial: discarded }
		})
		now = 25
		recorder.onEvent({
			type: 'message_update',
			message: discarded,
			assistantMessageEvent: {
				type: 'thinking_end',
				contentIndex: 0,
				content: 'Discard this.',
				partial: discarded
			}
		})
		recorder.onEvent({ type: 'message_end', message: discarded })
		recorder.dropLastMessage()

		now = 100
		const thought = assistant([
			{ type: 'thinking', thinking: 'Check it.' },
			{ type: 'toolCall', id: 'tc1', name: 'read', arguments: {} }
		])
		recorder.onEvent({ type: 'message_start', message: thought })
		recorder.onEvent({
			type: 'message_update',
			message: thought,
			assistantMessageEvent: { type: 'thinking_start', contentIndex: 0, partial: thought }
		})
		now = 140
		recorder.onEvent({
			type: 'message_update',
			message: thought,
			assistantMessageEvent: {
				type: 'thinking_end',
				contentIndex: 0,
				content: 'Check it.',
				partial: thought
			}
		})
		recorder.onEvent({ type: 'message_end', message: thought })
		recorder.onEvent({
			type: 'tool_execution_start',
			toolCallId: 'tc1',
			toolName: 'read',
			args: {}
		})
		now = 220
		recorder.onEvent({
			type: 'tool_execution_end',
			toolCallId: 'tc1',
			toolName: 'read',
			result: null,
			isError: true
		})
		const messages: AgentMessage[] = [
			thought,
			{
				role: 'toolResult',
				toolCallId: 'tc1',
				toolName: 'read',
				content: [{ type: 'text', text: 'failed' }],
				isError: true,
				timestamp: now
			}
		]

		const payloads = await recorder.write({
			volume: volume(memStore()),
			agentId: 'main',
			sessionId: 'session',
			messages,
			agentTools: [testTool('read')],
			diagnostic: () => undefined
		})
		expect(payloads).toMatchObject([
			{
				type: 'activity',
				items: [
					{ kind: 'think', durationMs: 40 },
					{ kind: 'tool', durationMs: 80, failed: true }
				]
			}
		])
	})

	test('retries an empty assistant response before persisting', async () => {
		const vol = volume(memStore())
		const rt = await createAssistant({
			...MAIN,
			volume: vol,
			agent: scriptedAgent([
				assistant([{ type: 'thinking', thinking: 'Discarded attempt' }]),
				assistant([
					{ type: 'thinking', thinking: 'Recovered attempt' },
					{ type: 'text', text: 'Recovered' }
				])
			]),
			text: testText(),
			compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 }
		})

		await expect(rt.prompt('hello')).resolves.toBe('Recovered')
		const history = await rt.history()
		expect(history).toMatchObject([
			{ type: 'message', role: 'user', content: 'hello' },
			{ type: 'activity', items: [{ kind: 'think' }] },
			{ type: 'message', role: 'assistant', content: 'Recovered' }
		])
		const activity = history[1]
		if (activity?.type !== 'activity') throw new Error('expected an activity entry')
		expect(await readDetail(vol, activity)).toEqual({
			items: [{ kind: 'think', content: 'Recovered attempt' }]
		})
	})

	test('records mixed activity runs in their original order', async () => {
		const vol = volume(memStore())
		const agent = scriptedAgent([
			assistant([
				{ type: 'thinking', thinking: 'Check the files.' },
				{ type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: 'one' } },
				{ type: 'toolCall', id: 'tc2', name: 'read', arguments: { path: 'two' } }
			]),
			assistant([
				{ type: 'text', text: 'I found the first clue.' },
				{ type: 'thinking', thinking: 'Check one more file.' },
				{ type: 'toolCall', id: 'tc3', name: 'read', arguments: { path: 'three' } }
			]),
			assistant([{ type: 'text', text: 'Done' }])
		])
		agent.state.tools = [testTool('read')]
		const rt = await createAssistant({
			...MAIN,
			volume: vol,
			agent,
			text: testText(),
			compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 }
		})

		await expect(rt.prompt('inspect')).resolves.toBe('I found the first clue.\nDone')
		const history = await rt.history()
		expect(history).toMatchObject([
			{ type: 'message', role: 'user', content: 'inspect' },
			{
				type: 'activity',
				items: [
					{ kind: 'think' },
					{ kind: 'tool', name: 'read', label: 'read' },
					{ kind: 'tool', name: 'read', label: 'read' }
				]
			},
			{ type: 'message', role: 'assistant', content: 'I found the first clue.' },
			{
				type: 'activity',
				items: [{ kind: 'think' }, { kind: 'tool', name: 'read', label: 'read' }]
			},
			{ type: 'message', role: 'assistant', content: 'Done' }
		])

		const runs = history.filter((entry): entry is ActivityRunEntry => entry.type === 'activity')
		expect(await Promise.all(runs.map((entry) => readDetail(vol, entry)))).toEqual([
			{
				items: [
					{ kind: 'think', content: 'Check the files.' },
					{ kind: 'tool', name: 'read', input: { path: 'one' }, result: 'ok' },
					{ kind: 'tool', name: 'read', input: { path: 'two' }, result: 'ok' }
				]
			},
			{
				items: [
					{ kind: 'think', content: 'Check one more file.' },
					{ kind: 'tool', name: 'read', input: { path: 'three' }, result: 'ok' }
				]
			}
		])
	})

	test('writes activity detail before appending its receipt', async () => {
		const backing = volume(memStore())
		const writes: string[] = []
		const vol: Volume = {
			...backing,
			async writeFile(path, data) {
				writes.push(`write:${path}`)
				return backing.writeFile(path, data)
			},
			async appendFile(path, data) {
				writes.push(`append:${path}`)
				return backing.appendFile(path, data)
			}
		}
		const agent = scriptedAgent([
			assistant([{ type: 'toolCall', id: 'tc1', name: 'read', arguments: {} }]),
			assistant([{ type: 'text', text: 'Done' }])
		])
		agent.state.tools = [testTool('read')]
		const rt = await createAssistant({
			...MAIN,
			volume: vol,
			agent,
			text: testText(),
			compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 }
		})

		await rt.prompt('inspect')
		const detail = writes.findIndex((write) => write.includes('/private/cache/agent-activity/'))
		const receipt = writes.findLastIndex((write) => write.includes('/sessions/'))
		expect(detail).toBeGreaterThan(-1)
		expect(receipt).toBeGreaterThan(detail)
	})

	test('keeps the conversation when an activity detail write fails', async () => {
		const backing = volume(memStore())
		const vol: Volume = {
			...backing,
			async writeFile(path, data) {
				if (path.startsWith('/private/cache/agent-activity/')) throw new Error('disk full')
				return backing.writeFile(path, data)
			}
		}
		const agent = scriptedAgent([
			assistant([{ type: 'toolCall', id: 'tc1', name: 'read', arguments: {} }]),
			assistant([{ type: 'text', text: 'Done' }])
		])
		agent.state.tools = [testTool('read')]
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		try {
			const rt = await createAssistant({
				...MAIN,
				volume: vol,
				agent,
				text: testText(),
				compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 }
			})

			await expect(rt.prompt('inspect')).resolves.toBe('Done')
			expect(await rt.history()).toMatchObject([
				{ type: 'message', role: 'user', content: 'inspect' },
				{ type: 'activity', items: [{ kind: 'tool', name: 'read' }] },
				{ type: 'message', role: 'assistant', content: 'Done' }
			])
			const receipt = (await rt.history())[1]
			expect(receipt).not.toHaveProperty('detailId')
		} finally {
			error.mockRestore()
		}
	})

	test('keeps ask_user inline and out of activity detail', async () => {
		const agent = scriptedAgent([
			assistant([
				{ type: 'thinking', thinking: 'The user needs to choose.' },
				{
					type: 'toolCall',
					id: 'tc1',
					name: 'ask_user',
					arguments: { question: 'Tea or coffee?', options: ['Tea', 'Coffee'] }
				}
			]),
			assistant([])
		])
		agent.state.tools = [testTool('ask_user')]
		const rt = await createAssistant({
			...MAIN,
			volume: volume(memStore()),
			agent,
			text: testText(),
			compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 }
		})

		await rt.prompt('help me choose')
		expect(await rt.history()).toMatchObject([
			{ type: 'message', role: 'user', content: 'help me choose' },
			{ type: 'activity', items: [{ kind: 'think' }] },
			{
				type: 'message',
				role: 'assistant',
				content: 'Tea or coffee?',
				options: [{ label: 'Tea' }, { label: 'Coffee' }]
			}
		])
	})

	test('keeps tool-produced images on the activity receipt', async () => {
		const images = [{ src: '/pictures/abcd1234.png', mimeType: 'image/png', alt: 'a red panda' }]
		const parameters = Type.Object({})
		const imageTool: AgentTool = {
			name: 'generate_image',
			label: 'generate_image',
			description: 'generate_image',
			parameters,
			async execute() {
				return { content: [{ type: 'text', text: 'saved' }], details: { images } }
			}
		} satisfies AgentTool<typeof parameters>

		const agent = scriptedAgent([
			assistant([{ type: 'toolCall', id: 'tc1', name: 'generate_image', arguments: {} }]),
			assistant([{ type: 'text', text: 'There you go' }])
		])
		agent.state.tools = [imageTool]
		const vol = volume(memStore())
		const rt = await createAssistant({
			...MAIN,
			volume: vol,
			agent,
			text: testText(),
			compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 }
		})

		await expect(rt.prompt('draw a red panda')).resolves.toBe('There you go')
		const history = await rt.history()
		expect(history).toMatchObject([
			{ type: 'message', role: 'user', content: 'draw a red panda' },
			{
				type: 'activity',
				items: [{ kind: 'tool', name: 'generate_image' }],
				images
			},
			{ type: 'message', role: 'assistant', content: 'There you go' }
		])
		const entry = history[1]
		if (entry?.type !== 'activity') throw new Error('expected an activity entry')
		expect(await readDetail(vol, entry)).toEqual({
			items: [{ kind: 'tool', name: 'generate_image', input: {}, result: 'saved' }]
		})
	})
})

describe('assistant tool API', () => {
	test('adds tools to the agent tool list', async () => {
		const agent = new Agent()
		const rt = await createAssistant({
			...MAIN,
			volume: volume(memStore()),
			agent,
			text: testText(),
			compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 }
		})

		const first = testTool('first')
		const second = testTool('second')
		rt.addTools([first, second])
		expect(agent.state.tools).toEqual([first, second])
	})

	test('returns the composed system prompt', async () => {
		const vol = volume(memStore())
		await vol.mkdir('/system/agents/main', { recursive: true })
		await vol.mkdir('/system/memory/daily', { recursive: true })
		await vol.writeFile('/system/agents/main/soul.md', encoder.encode('soul'))
		await vol.writeFile('/system/user.md', encoder.encode('profile'))
		await vol.writeFile('/system/memory/core.md', encoder.encode('memory'))
		const today = new Date().toISOString().slice(0, 10)
		await vol.writeFile(`/system/memory/daily/${today}.md`, encoder.encode('daily'))

		const agent = new Agent()
		const rt = await createAssistant({
			...MAIN,
			volume: vol,
			agent,
			text: testText(),
			compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
			getTimezone: () => 'UTC'
		})

		const expected = systemPrompt('soul')
		expected.add('# your filesystem', filesystemPrompt({ os: false }))
		expected.add('# about the user', 'profile')
		expected.add(
			'# current time',
			rt.systemPrompt().match(/Now: .* \(UTC\)\./)?.[0] ?? '',
			'When the user references relative dates ("today", "tomorrow", "next week"), interpret them in this timezone.',
			"When passing date: arguments to calendar tools, use ISO 8601 with the user's offset (or 'Z' for UTC). The agent is responsible for the conversion.",
			'If this session has been running long enough that the time above may be stale, run `date` to get the current time.'
		)
		expected.add('# permanent memory', 'memory')
		expected.add(
			'# memories of the past 2 days',
			'Recent daily notes (last 2 days). These are raw, unprocessed jottings from recent sessions — treat as lower-priority hints than the durable memory above. They may be noisy, redundant, or contradicted by later facts; defer to the durable memory on conflict.',
			`## ${today}\ndaily`
		)
		expect(rt.systemPrompt()).toBe(expected.build())
	})

	test('injects the user age computed from the profile birth date', async () => {
		const vol = volume(memStore())
		await vol.mkdir('/system', { recursive: true })
		await vol.writeFile(
			'/system/user.md',
			encoder.encode('---\nname: Ada\nbirth_date: 1990-06-15\n---\n')
		)
		const rt = await createAssistant({
			...MAIN,
			volume: vol,
			agent: new Agent(),
			text: testText(),
			compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 }
		})
		expect(rt.systemPrompt()).toMatch(/The user is \d+ years old\./)
	})

	test('adds the apps block from appsPrompt', async () => {
		const rt = await createAssistant({
			...MAIN,
			volume: volume(memStore()),
			agent: new Agent(),
			text: testText(),
			compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
			appsPrompt: 'Run `app list` to see installed apps.'
		})
		expect(rt.systemPrompt()).toContain('# apps')
		expect(rt.systemPrompt()).toContain('Run `app list` to see installed apps.')
	})

	test('orients the agent on the filesystem, and mentions `os windows` only with an os port', async () => {
		const make = (os: boolean) =>
			createAssistant({
				...MAIN,
				volume: volume(memStore()),
				agent: new Agent(),
				text: testText(),
				compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
				os
			})

		const without = (await make(false)).systemPrompt()
		expect(without).toContain('# your filesystem')
		expect(without).toContain('/notes/')
		expect(without).not.toContain('os windows')

		expect((await make(true)).systemPrompt()).toContain('os windows')
	})
})
