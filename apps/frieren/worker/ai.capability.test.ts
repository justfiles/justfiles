import type { LLMText } from '@justfiles/agent'
import { type CapabilityCall, capabilityRegistry } from '@justfiles/app/capabilities'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { memStorage, type Volume, volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { aiCapability } from './ai.capability.ts'

const call = (
	capability: string,
	method: string,
	input: unknown,
	scopes: readonly string[] = []
): CapabilityCall => ({
	appId: 'app',
	capability,
	method,
	args: [input],
	scopes
})

const fakeText: LLMText = {
	gen: async (_system, prompt) => `echo:${prompt}`,
	takeNotes: async () => undefined,
	summarise: async () => ''
}

// A text model that records the system prompt of the FINAL generation, while
// answering the internal learning-extraction call with strict JSON — so a test can
// assert the host-composed fragment reached the model but never the app.
function recordingText(): LLMText & { system: string } {
	const self = {
		system: '',
		gen: async (system: string, prompt: string) => {
			if (system.includes('STRICT JSON'))
				return JSON.stringify({
					interests: ['Minecraft'],
					avoidTopics: [],
					learningPreferences: []
				})
			self.system = system
			return `echo:${prompt}`
		},
		takeNotes: async () => undefined,
		summarise: async () => ''
	}
	return self
}

const enc = new TextEncoder()
async function seedLearner(vol: Volume) {
	await vol.mkdir('/system/memory', { recursive: true })
	await vol.writeFile('/system/user.md', enc.encode('---\nbirth_date: 2015-06-15\n---\n'))
	await vol.writeFile(
		'/system/memory/core.md',
		enc.encode('Loves Minecraft. Dislikes scary stories.')
	)
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

	test('context: learning without the scope is DENIED', async () => {
		const fs = volume(memStorage())
		await seedLearner(fs)
		const cap = aiCapability(fakeText, fs)
		await expect(
			cap.invoke(call('ai', 'generateText', { prompt: 'hi', context: 'learning' }))
		).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
	})

	test('scoped learning context prepends the host fragment to the model system prompt', async () => {
		const fs = volume(memStorage())
		await seedLearner(fs)
		const text = recordingText()
		const cap = aiCapability(text, fs)
		const res = await cap.invoke(
			call('ai', 'generateText', { system: 'APP', prompt: 'define run', context: 'learning' }, [
				'context:learning'
			])
		)
		// The app receives only the model output — never the fragment or composed prompt.
		expect(res).toEqual({ text: 'echo:define run' })
		// The model saw the host-composed learning fragment ahead of the app prompt.
		expect(text.system).toContain('# Learning adaptation')
		expect(text.system).toContain('Known interests: Minecraft.')
		expect(text.system.trimEnd().endsWith('APP')).toBe(true)
	})
})
