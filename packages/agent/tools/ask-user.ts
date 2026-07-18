/**
 * Ask-user tool — pose a multiple-choice question WITHOUT suspending the turn.
 * The tool hands the question + options to the host (which records it as the
 * assistant turn and pings a `question` notification); the turn then completes.
 * The user's pick is just the next prompt — no blocking elicitation, no
 * coroutine. (notify Slice 3.)
 */

import type { AgentTool } from '@earendil-works/pi-agent-core'
import Type from 'typebox'

const askUserParams = Type.Object({
	question: Type.String({ description: 'The question to put to the user.' }),
	options: Type.Array(Type.String({ description: 'A short, selectable answer.' }), {
		description: 'The choices the user picks from (a handful of short labels).'
	})
})

export function createAskUserTool(
	onAsk: (question: string, options: string[]) => void
): AgentTool<typeof askUserParams> {
	return {
		name: 'ask_user',
		label: 'Ask User',
		description:
			'Ask the user a multiple-choice question when you genuinely need them to choose between options to proceed. Provide a clear question and the selectable answers. Do NOT keep talking afterwards — end your turn; the user’s selection arrives as the next message.',
		parameters: askUserParams,
		async execute(_toolCallId, params) {
			const question = params.question.trim()
			const options = params.options.map((o) => o.trim()).filter(Boolean)
			onAsk(question, options)
			return {
				content: [
					{
						type: 'text',
						text: 'Posed the question to the user; their selection arrives as the next message. End your turn now without further commentary.'
					}
				],
				details: { question, options }
			}
		}
	}
}
