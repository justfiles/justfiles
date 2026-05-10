import { describe, expect, test } from 'bun:test'
import { volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { Agent, type AgentTool } from '@mariozechner/pi-agent-core'
import Type from 'typebox'
import { runtime } from './frieren.runtime'
import type { LLMText } from './llm.text'
import { systemPrompt } from './prompts'

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

describe('runtime tool API', () => {
	test('adds and removes tools on the agent tool list', async () => {
		const agent = new Agent()
		const rt = await runtime({
			volume: volume(memStorage()),
			agent,
			text: testText(),
			compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 }
		})

		const first = testTool('first')
		const second = testTool('second')
		rt.addTools([first, second])
		expect(agent.state.tools).toEqual([first, second])

		rt.removeTools([first])
		expect(agent.state.tools).toEqual([second])
	})

	test('returns the composed system prompt', async () => {
		const vol = volume(memStorage())
		await vol.mkdir('/profiles')
		await vol.mkdir('/memory')
		await vol.mkdir('/memory/daily')
		await vol.writeFile('/soul.md', encoder.encode('soul'))
		await vol.writeFile('/profiles/user.md', encoder.encode('profile'))
		await vol.writeFile('/MEMORY.md', encoder.encode('memory'))
		const today = new Date().toISOString().slice(0, 10)
		await vol.writeFile(`/memory/daily/${today}.md`, encoder.encode('daily'))

		const agent = new Agent()
		const rt = await runtime({
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
