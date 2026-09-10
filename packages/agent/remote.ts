import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	type SimpleStreamOptions
} from '@earendil-works/pi-ai'
import type { AiSelection } from '@justfiles/app/accounts/host'
import { z } from 'zod'
import type { AgentBackend } from './llm.ts'

export type BackendDescriptor = {
	version: 1
	model: AgentBackend['model']
	selection: AiSelection
	revision: string
}

// The wire accepts model inputs, never provider URLs, headers, keys or callbacks.
export const inferenceRequest = z
	.object({
		version: z.literal(1),
		selection: z.object({
			accountId: z.string().max(256),
			model: z.string().max(256).optional(),
			revision: z.string().max(256)
		}),
		context: z
			.object({
				systemPrompt: z.string().optional(),
				messages: z.array(
					z.object({ role: z.enum(['user', 'assistant', 'toolResult']) }).passthrough()
				),
				tools: z
					.array(
						z.object({
							name: z.string().max(256),
							description: z.string(),
							parameters: z.record(z.string(), z.unknown())
						})
					)
					.optional()
			})
			.strict(),
		options: z
			.object({
				temperature: z.number().min(0).max(2).optional(),
				maxTokens: z.number().int().positive().max(1_000_000).optional(),
				reasoning: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
				sessionId: z.string().max(256).optional(),
				cacheRetention: z.enum(['none', 'short', 'long']).optional(),
				thinkingBudgets: z
					.object({
						minimal: z.number().int().nonnegative().optional(),
						low: z.number().int().nonnegative().optional(),
						medium: z.number().int().nonnegative().optional(),
						high: z.number().int().nonnegative().optional()
					})
					.optional()
			})
			.strict()
			.default({})
	})
	.strict()

export function describeBackend(backend: AgentBackend, selection: AiSelection): BackendDescriptor {
	const { id, api, provider, name, reasoning, input, cost, contextWindow, maxTokens } =
		backend.model
	return {
		version: 1,
		selection,
		revision: backend.revision,
		model: {
			id,
			api,
			provider,
			name,
			reasoning,
			input,
			cost,
			contextWindow,
			maxTokens,
			baseUrl: ''
		}
	}
}

export function remoteBackend(
	descriptor: BackendDescriptor,
	request: (body: unknown, signal: AbortSignal) => Promise<Response>
): AgentBackend {
	const streamFn: AgentBackend['streamFn'] = (_model, context, options) => {
		const output = createAssistantMessageEventStream()
		const timeout = AbortSignal.timeout(5 * 60_000)
		const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout
		void (async () => {
			try {
				const { temperature, maxTokens, reasoning, sessionId, cacheRetention, thinkingBudgets } =
					(options ?? {}) as SimpleStreamOptions
				const response = await request(
					{
						version: 1,
						selection: descriptor.selection,
						context,
						options: {
							temperature,
							maxTokens,
							reasoning,
							sessionId,
							cacheRetention,
							thinkingBudgets
						}
					},
					signal
				)
				if (!response.ok)
					throw new Error((await response.text()) || `AI request failed (${response.status})`)
				if (
					!response.body ||
					response.headers.get('content-type')?.split(';')[0] !== 'application/x-ndjson'
				)
					throw new Error('The cloud AI transport is unavailable. Update Frieren and try again.')
				const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
				let pending = ''
				try {
					while (true) {
						const { done, value } = await reader.read()
						if (done) break
						pending += value
						const lines = pending.split('\n')
						pending = lines.pop() ?? ''
						for (const line of lines) {
							if (!line) continue
							const event = JSON.parse(line) as AssistantMessageEvent
							output.push(event)
							if (event.type === 'done' || event.type === 'error') return
						}
					}
					throw new Error('AI stream ended before completing. Please retry.')
				} finally {
					await reader.cancel().catch(() => {})
				}
			} catch (error) {
				const message = failureMessage(descriptor.model, error, options?.signal?.aborted)
				output.push({
					type: 'error',
					reason: message.stopReason as 'error' | 'aborted',
					error: message
				})
			} finally {
				output.end()
			}
		})()
		return output
	}
	return {
		model: descriptor.model,
		revision: descriptor.revision,
		streamFn,
		completeFn: async (model, context, options) =>
			(await streamFn(model, context, options)).result()
	}
}

export function failureMessage(
	model: AgentBackend['model'],
	error: unknown,
	aborted = false
): AssistantMessage {
	return {
		role: 'assistant',
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
		},
		stopReason: aborted ? 'aborted' : 'error',
		errorMessage: error instanceof Error ? error.message : 'AI request failed',
		timestamp: Date.now()
	}
}
