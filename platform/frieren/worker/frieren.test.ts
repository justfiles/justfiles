import type { SessionEntry } from '@justfiles/agent'
import { sessionEntriesToTranscriptItems } from '@justfiles/agent/protocol'
import { describe, expect, test } from 'vitest'

const ts = '2026-05-23T05:02:17.578Z'

describe('Frieren transcript projection', () => {
	test('projects user.gov session without leaking tool_result as plain text', () => {
		const entries: SessionEntry[] = [
			{
				type: 'message',
				role: 'user',
				content: 'can you increase the counter to 15',
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

		const display = sessionEntriesToTranscriptItems(entries, { expressions: true })

		for (const m of display) {
			if (m.type === 'message') expect(m.content.startsWith('[')).toBe(false)
		}

		const finalAssistant = display.find(
			(m) => m.type === 'message' && m.content === 'Done — the counter is now 15.'
		)
		expect(finalAssistant).toBeDefined()

		const toolHost = display.find((m) => m.type === 'activity')
		expect(toolHost).toBeDefined()
		expect(toolHost?.type === 'activity' && toolHost.items).toHaveLength(4)
	})

	test('carries image refs from a tool_result entry onto its tool call', () => {
		const images = [{ src: '/pictures/abcd1234.png', mimeType: 'image/png', alt: 'a red panda' }]
		const entries: SessionEntry[] = [
			{
				type: 'message',
				role: 'tool_call',
				tool_name: 'generate_image',
				input: { prompt: 'a red panda' },
				id: 'a1',
				parentId: null,
				ts
			},
			{
				type: 'message',
				role: 'tool_result',
				tool_name: 'generate_image',
				content: 'Generated an image and saved to /pictures/abcd1234.png.',
				images,
				id: 'a2',
				parentId: 'a1',
				ts
			}
		]

		const projected = sessionEntriesToTranscriptItems(entries, { expressions: true })
		expect(projected[1]).toEqual({ id: 'a2:image:0', type: 'image', image: images[0] })
	})
})
