import { Agent, type AgentTool } from '@earendil-works/pi-agent-core'
import { type AssistantMessage, createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import Type from 'typebox'
import { describe, expect, test } from 'vitest'
import { createAssistant } from './assistant.ts'
import type { LLMText } from './llm.text.ts'
import { systemPrompt } from './prompts.ts'

const encoder = new TextEncoder()

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

describe('assistant prompt', () => {
	test('retries an empty assistant response before persisting', async () => {
		const rt = await createAssistant({
			volume: volume(memStorage()),
			agent: scriptedAgent([assistant([]), assistant([{ type: 'text', text: 'Recovered' }])]),
			text: testText(),
			compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 }
		})

		await expect(rt.prompt('hello')).resolves.toBe('Recovered')
		expect(await rt.history()).toMatchObject([
			{ type: 'message', role: 'user', content: 'hello' },
			{ type: 'message', role: 'assistant', content: 'Recovered' }
		])
	})
})

describe('assistant tool API', () => {
	test('adds tools to the agent tool list', async () => {
		const agent = new Agent()
		const rt = await createAssistant({
			volume: volume(memStorage()),
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
		const vol = volume(memStorage())
		await vol.mkdir('/system/agents/main', { recursive: true })
		await vol.mkdir('/system/memory/daily', { recursive: true })
		await vol.writeFile('/system/agents/main/soul.md', encoder.encode('soul'))
		await vol.writeFile('/system/user.md', encoder.encode('profile'))
		await vol.writeFile('/system/memory/core.md', encoder.encode('memory'))
		const today = new Date().toISOString().slice(0, 10)
		await vol.writeFile(`/system/memory/daily/${today}.md`, encoder.encode('daily'))

		const agent = new Agent()
		const rt = await createAssistant({
			volume: vol,
			agent,
			text: testText(),
			compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
			getTimezone: () => 'UTC'
		})

		const expected = systemPrompt('soul')
		expected.add('# about the user', 'profile')
		expected.add(
			'# current time',
			rt.systemPrompt().match(/Now: .* \(UTC\)\./)?.[0] ?? '',
			'When the user references relative dates ("today", "tomorrow", "next week"), interpret them in this timezone.',
			"When passing date: arguments to calendar tools, use ISO 8601 with the user's offset (or 'Z' for UTC). The agent is responsible for the conversion.",
			'If this session has been running long enough that the time above may be stale, run `now` to get the current time.'
		)
		expected.add('# permanent memory', 'memory')
		expected.add(
			'# memories of the past 2 days',
			'Recent daily notes (last 2 days). These are raw, unprocessed jottings from recent sessions — treat as lower-priority hints than the durable memory above. They may be noisy, redundant, or contradicted by later facts; defer to the durable memory on conflict.',
			`## ${today}\ndaily`
		)
		expect(rt.systemPrompt()).toBe(expected.build())
	})
})
