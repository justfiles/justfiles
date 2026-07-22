import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core'
import type { Message } from '@earendil-works/pi-ai'
import type { AgentBackend } from './llm'

export function createAgent(backend: AgentBackend): Agent {
	const agent = new Agent({
		initialState: {
			systemPrompt: '', // set dynamically each turn in webSocketMessage
			model: backend.model,
			thinkingLevel: 'low'
		},
		convertToLlm: (messages: AgentMessage[]): Message[] => buildModelVisibleMessages(messages),
		// No `getApiKey`: `streamFn` is the sole auth seam, so the agent holds no token.
		streamFn: backend.streamFn
	})

	// TODO: cut off line threads
	agent.transformContext = async (messages) => messages

	return agent
}

function buildModelVisibleMessages(messages: AgentMessage[]): Message[] {
	const out: Message[] = []

	for (const message of messages) {
		// AgentMessage now spans agent-internal variants (custom/branchSummary/…) that
		// also carry a `role`; keep only the LLM message roles, which narrows to `Message`.
		if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'toolResult')
			continue

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
