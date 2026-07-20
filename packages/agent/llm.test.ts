import type { StreamFn } from '@earendil-works/pi-agent-core'
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type Usage
} from '@earendil-works/pi-ai'
import { describe, expect, test } from 'vitest'
import { type AgentBackend, meterBackend } from './llm.ts'

const model = { id: 'test', provider: 'test' } as unknown as Model

function usage(total: number): Usage {
	return {
		input: total,
		output: total,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: total * 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total }
	}
}

function message(u: Usage, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
	return {
		role: 'assistant',
		content: [{ type: 'text', text: 'hi' }],
		api: 'test',
		provider: 'test',
		model: 'test',
		usage: u,
		stopReason,
		timestamp: Date.now()
	}
}

// Backend whose streamFn/completeFn return the given terminal message.
function backend(msg: AssistantMessage): AgentBackend {
	return {
		model,
		completeFn: async () => msg,
		streamFn: (() => {
			const stream = createAssistantMessageEventStream()
			if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
				stream.push({ type: 'error', reason: msg.stopReason, error: msg })
			} else {
				stream.push({ type: 'done', reason: 'stop', message: msg })
			}
			stream.end(msg)
			return stream
		}) as StreamFn,
		revision: 'test'
	}
}

describe('meterBackend', () => {
	test('reports usage from completeFn and passes the message through', async () => {
		const seen: Usage[] = []
		const msg = message(usage(3))
		const metered = meterBackend(backend(msg), (u) => seen.push(u))

		const result = await metered.completeFn(model, { messages: [] })

		expect(result).toBe(msg)
		expect(seen).toEqual([usage(3)])
	})

	test('reports usage from a streamed turn without disturbing iteration', async () => {
		const seen: Usage[] = []
		const msg = message(usage(5))
		const metered = meterBackend(backend(msg), (u) => seen.push(u))

		const stream = await metered.streamFn(model, { messages: [] })
		const events = []
		for await (const event of stream) events.push(event.type)
		// Let the .result() microtask settle.
		await stream.result()

		expect(events).toEqual(['done'])
		expect(seen).toEqual([usage(5)])
	})

	test('still meters a failed/aborted turn (usage rides the error terminal)', async () => {
		const seen: Usage[] = []
		const msg = message(usage(2), 'error')
		const metered = meterBackend(backend(msg), (u) => seen.push(u))

		const stream = await metered.streamFn(model, { messages: [] })
		await stream.result()

		expect(seen).toEqual([usage(2)])
	})
})
