import type { SessionEntry } from '@justfiles/agent'
import { describe, expect, test } from 'vitest'
import { sessionEntries2DisplayMessages } from './display'

const ts = '2026-05-23T05:02:17.578Z'

describe('sessionEntries2DisplayMessages', () => {
	test('projects user.gov session without leaking tool_result as plain text', () => {
		const entries: SessionEntry[] = [
			{
				type: 'message',
				role: 'user',
				content: 'can you increase the counter to 15',
				source: 'user',
				id: 'b17bdee2',
				parentId: null,
				ts
			},
			{
				type: 'message',
				role: 'assistant',
				content: 'I can, but I need to know where the counter lives.',
				id: '234ec2c0',
				parentId: 'b17bdee2',
				ts
			},
			{
				type: 'message',
				role: 'user',
				content: 'the counter is the current running app',
				source: 'user',
				id: '53ede100',
				parentId: '234ec2c0',
				ts
			},
			{
				type: 'message',
				role: 'tool_call',
				tool_name: 'bash',
				input: { command: 'app --help' },
				id: '1fa95076',
				parentId: '53ede100',
				ts
			},
			{
				type: 'message',
				role: 'tool_result',
				tool_name: 'bash',
				content: '{"usage":"app …"}',
				id: '43899af2',
				parentId: '1fa95076',
				ts
			},
			{
				type: 'message',
				role: 'tool_result',
				tool_name: 'bash',
				content: '{"apps":[]}',
				id: 'e52f301d',
				parentId: '43899af2',
				ts
			},
			{
				type: 'message',
				role: 'tool_call',
				tool_name: 'bash',
				input: { command: 'app current' },
				id: '5ebc8cb2',
				parentId: 'e52f301d',
				ts
			},
			{
				type: 'message',
				role: 'tool_result',
				tool_name: 'bash',
				content: '{"count":4}',
				id: '9841e2f9',
				parentId: '5ebc8cb2',
				ts
			},
			{
				type: 'message',
				role: 'tool_call',
				tool_name: 'bash',
				input: { command: 'app run …' },
				id: 'c4bbdda8',
				parentId: '9841e2f9',
				ts
			},
			{
				type: 'message',
				role: 'tool_result',
				tool_name: 'bash',
				content: '{"count":15}',
				id: '61b84254',
				parentId: 'c4bbdda8',
				ts
			},
			{
				type: 'message',
				role: 'assistant',
				content: 'Done — the counter is now 15.',
				id: '5e134c83',
				parentId: '61b84254',
				ts
			}
		]

		const display = sessionEntries2DisplayMessages(entries)

		for (const m of display) {
			expect(m.content.startsWith('[')).toBe(false)
		}

		const finalAssistant = display.find((m) => m.content === 'Done — the counter is now 15.')
		expect(finalAssistant).toBeDefined()

		const toolHost = display.find((m) => (m.toolCalls?.length ?? 0) > 0)
		expect(toolHost).toBeDefined()
		expect(toolHost?.toolCalls?.length).toBe(4)
		expect(toolHost?.toolCalls?.every((tc) => tc.result !== undefined)).toBe(true)
	})
})
