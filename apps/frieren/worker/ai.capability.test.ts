import { type CapabilityCall, capabilityRegistry } from '@justfiles/app/capabilities'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { memStorage, volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { aiCapability } from './ai.capability.ts'
import type { LLMText } from './llm.text.ts'

const call = (capability: string, method: string, input: unknown): CapabilityCall => ({
	appId: 'app',
	capability,
	method,
	args: [input],
	scopes: []
})

const fakeText: LLMText = {
	gen: async (_system, prompt) => `echo:${prompt}`,
	takeNotes: async () => undefined,
	summarise: async () => ''
}

describe('ai capability', () => {
	test('generateText returns the model text', async () => {
		const cap = aiCapability(fakeText)
		expect(await cap.invoke(call('ai', 'generateText', { prompt: 'hi' }))).toEqual({
			text: 'echo:hi'
		})
	})

	test('rejects a missing prompt as INVALID_INPUT', async () => {
		const cap = aiCapability(fakeText)
		await expect(cap.invoke(call('ai', 'generateText', {}))).rejects.toMatchObject({
			code: 'CAPABILITY_INVALID_INPUT'
		})
	})

	test('a registry routes each name to its unit; an unknown name is UNAVAILABLE', async () => {
		const fs = volume(memStorage())
		const caps = capabilityRegistry({ volume: volumeCapability(fs), ai: aiCapability(fakeText) })
		expect(await caps.invoke(call('ai', 'generateText', { prompt: 'hi' }))).toMatchObject({
			text: expect.any(String)
		})
		await expect(caps.invoke(call('nope', 'm', 1))).rejects.toMatchObject({
			code: 'CAPABILITY_UNAVAILABLE'
		})
	})
})
