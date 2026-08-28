import type { SessionEntry } from '@justfiles/agent'
import { describe, expect, test } from 'vitest'
import { sessionEntries2DisplayMessages } from './display'

function assistant(content: string): SessionEntry {
	return { type: 'message', role: 'assistant', content } as SessionEntry
}

describe('sessionEntries2DisplayMessages', () => {
	// The live stream strips tags in the browser (os/client.ts); replayed history has to
	// arrive equally clean or a reload would suddenly show the markup.
	test('strips expression tags from replayed assistant turns', () => {
		const messages = sessionEntries2DisplayMessages([
			assistant('[pleased]Found it. [concerned]The table is gone.')
		])
		expect(messages).toEqual([{ role: 'assistant', content: 'Found it. The table is gone.' }])
	})

	test('leaves ordinary brackets alone', () => {
		const messages = sessionEntries2DisplayMessages([assistant('see [the docs](https://x.dev)')])
		expect(messages[0].content).toBe('see [the docs](https://x.dev)')
	})

	test('keeps ask_user options in replayed history', () => {
		const options = [{ label: 'Tea' }, { label: 'Coffee' }]
		const messages = sessionEntries2DisplayMessages([
			{ ...assistant('Tea or coffee?'), options } as SessionEntry
		])

		expect(messages).toEqual([{ role: 'assistant', content: 'Tea or coffee?', options }])
	})

	test('keeps receipt images visible before the shared activity projector lands', () => {
		const images = [{ src: '/pictures/red-panda.png', mimeType: 'image/png', alt: 'red panda' }]
		const messages = sessionEntries2DisplayMessages([
			{
				type: 'activity',
				id: 'activity-1',
				parentId: null,
				ts: '2026-08-28T00:00:00.000Z',
				items: [
					{
						kind: 'tool',
						name: 'generate_image',
						label: 'Generate image',
						durationMs: 100
					}
				],
				images
			}
		])

		expect(messages).toEqual([
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ name: 'generate_image', args: undefined, images }]
			}
		])
	})
})
