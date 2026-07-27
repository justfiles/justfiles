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
})
