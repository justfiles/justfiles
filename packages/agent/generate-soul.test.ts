import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai'
import { describe, expect, test, vi } from 'vitest'
import { generateSoul } from './generate-soul.ts'
import type { AgentBackend } from './llm.ts'

function response(text: string): AssistantMessage {
	return {
		role: 'assistant',
		content: [{ type: 'text', text }],
		api: 'test',
		provider: 'test',
		model: 'test',
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
		},
		stopReason: 'stop',
		timestamp: Date.now()
	}
}

function backend(...answers: string[]): AgentBackend {
	return {
		model: { id: 'test' } as Model<Api>,
		streamFn: vi.fn(() => {
			throw new Error('soul preview built the assistant')
		}),
		completeFn: vi.fn(async () => response(answers.shift() ?? '')),
		revision: 'test'
	}
}

describe('generateSoul', () => {
	test('generates a preview directly from the supplied backend', async () => {
		const llm = backend('A patient companion.')

		await expect(
			generateSoul(llm, {
				agentName: 'Fern',
				agentGender: 'female',
				archetype: 'companion',
				userAge: 32,
				userGender: 'non-binary'
			})
		).resolves.toEqual({ body: 'A patient companion.' })
		expect(llm.completeFn).toHaveBeenCalledOnce()
		expect(llm.streamFn).not.toHaveBeenCalled()
	})

	test('optionally generates frieren first words', async () => {
		const llm = backend('A patient companion.', 'I am glad to meet you.')

		await expect(generateSoul(llm, { agentName: 'Fern' }, { firstWords: true })).resolves.toEqual({
			body: 'A patient companion.',
			firstWords: 'I am glad to meet you.'
		})
		expect(llm.completeFn).toHaveBeenCalledTimes(2)
	})
})
