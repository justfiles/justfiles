/**
 * Take-note tool — record a durable note for the current session. Notes are
 * reviewed when the session closes and may become permanent memory.
 */

import type { AgentTool } from '@earendil-works/pi-agent-core'
import Type from 'typebox'

const takeNoteParams = Type.Object({
	content: Type.String({
		description:
			'One short sentence capturing a durable fact, preference, decision, or follow-up worth remembering across sessions.'
	})
})

export function createTakeNoteTool(
	append: (content: string) => Promise<void>
): AgentTool<typeof takeNoteParams> {
	return {
		name: 'takeNote',
		label: 'Take Note',
		description:
			'Record a durable note for the current session. Use when the user tells you a fact, preference, decision, or follow-up worth remembering across sessions. Notes are reviewed when the session closes and may become permanent memory.',
		parameters: takeNoteParams,
		async execute(_toolCallId, params) {
			const content = params.content.trim()
			if (content.length === 0) {
				return {
					content: [{ type: 'text', text: 'Empty note, skipped.' }],
					details: { skipped: true }
				}
			}
			await append(content)
			return {
				content: [{ type: 'text', text: `Noted: ${content}` }],
				details: { content }
			}
		}
	}
}
