import { Agent, type AgentMessage } from '@mariozechner/pi-agent-core'
import { type Message, streamSimple } from '@mariozechner/pi-ai'
import type { LLMConfig } from './llm'

export function createAgent({ model, apiKey }: LLMConfig): Agent {
	const agent = new Agent({
		initialState: {
			systemPrompt: '', // set dynamically each turn in webSocketMessage
			model
		},
		convertToLlm: (messages: AgentMessage[]): Message[] => buildModelVisibleMessages(messages),
		getApiKey: () => apiKey,
		streamFn: (model, context, options) => {
			return streamSimple(model, context, {
				...options,
				apiKey
			})
		}
	})

	// TODO: cut off line threads
	agent.transformContext = async (messages) => messages

	return agent
}

function buildModelVisibleMessages(messages: AgentMessage[]): Message[] {
	const out: Message[] = []

	for (const message of messages) {
		if (!('role' in message)) continue

		if (message.role === 'assistant') {
			const content = Array.isArray(message.content) ? message.content : []
			const hasText = content.some((block) => block.type === 'text' && block.text.trim().length > 0)
			const hasToolCalls = content.some((block) => block.type === 'toolCall')

			// Thinking-only assistant turns are not useful model-visible context
			// for the next request. Keeping them would effectively erase the
			// assistant turn and leave the prior user message orphaned.
			if (!hasText && !hasToolCalls) continue
		}

		if (message.role === 'user') {
			const prev = out[out.length - 1]

			// Consecutive user turns indicate an earlier prompt never produced
			// durable assistant text. Keep only the latest user prompt so the
			// next model call answers the freshest request.
			if (prev?.role === 'user') {
				out[out.length - 1] = message
				continue
			}
		}

		out.push(message)
	}

	while (out[0]?.role === 'assistant') {
		out.shift()
	}

	return out
}
