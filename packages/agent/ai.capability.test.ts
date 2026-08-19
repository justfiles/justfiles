import type { CapabilityCall } from '@justfiles/app/capabilities'
import { type Volume, volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { beforeEach, describe, expect, test } from 'vitest'
import { aiCapability, type GenerateText } from './ai.capability.ts'

const enc = new TextEncoder()

const call = (input: unknown, scopes: readonly string[] = []): CapabilityCall => ({
	appId: 'app',
	capability: 'ai',
	method: 'generateText',
	args: [input],
	scopes
})

// Records the composed system prompt it was handed; answers the internal learning
// extraction with strict JSON so a scoped call produces a real fragment.
function recordingGenerate(): GenerateText & { system: string } {
	const gen = Object.assign(
		async ({ system, prompt }: { system: string; prompt: string }) => {
			if (system.includes('STRICT JSON'))
				return JSON.stringify({
					interests: ['Minecraft'],
					avoidTopics: [],
					learningPreferences: []
				})
			gen.system = system
			return `echo:${prompt}`
		},
		{ system: '' }
	)
	return gen
}

async function seedLearner(vol: Volume) {
	await vol.mkdir('/system/memory', { recursive: true })
	await vol.writeFile('/system/user.md', enc.encode('---\nbirth_date: 2015-06-15\n---\n'))
	await vol.writeFile(
		'/system/memory/core.md',
		enc.encode('Loves Minecraft. Dislikes scary tales.')
	)
}

describe('aiCapability', () => {
	let vol: Volume
	beforeEach(() => {
		vol = volume(memStore())
	})

	test('generateText returns the model text', async () => {
		const cap = aiCapability({ generate: async ({ prompt }) => `echo:${prompt}` })
		expect(await cap.invoke(call({ prompt: 'hi' }))).toEqual({ text: 'echo:hi' })
	})

	test('rejects a missing prompt as INVALID_INPUT', async () => {
		const cap = aiCapability({ generate: async () => '' })
		await expect(cap.invoke(call({}))).rejects.toMatchObject({ code: 'CAPABILITY_INVALID_INPUT' })
	})

	test('a context-free call passes the app system prompt through unchanged', async () => {
		const gen = recordingGenerate()
		const cap = aiCapability({ volume: vol, generate: gen })
		await cap.invoke(call({ system: 'APP', prompt: 'hi' }))
		expect(gen.system).toBe('APP')
	})

	test('context: learning without the scope is DENIED', async () => {
		await seedLearner(vol)
		const cap = aiCapability({ volume: vol, generate: recordingGenerate() })
		await expect(cap.invoke(call({ prompt: 'hi', context: 'learning' }))).rejects.toMatchObject({
			code: 'CAPABILITY_DENIED'
		})
	})

	test('an unknown context value is INVALID_INPUT (the union is not an open string)', async () => {
		const cap = aiCapability({ volume: vol, generate: recordingGenerate() })
		await expect(
			cap.invoke(call({ prompt: 'hi', context: 'writing' }, ['context:learning']))
		).rejects.toMatchObject({ code: 'CAPABILITY_INVALID_INPUT' })
	})

	test('scoped learning context prepends the host fragment to the model system prompt', async () => {
		await seedLearner(vol)
		const gen = recordingGenerate()
		const cap = aiCapability({ volume: vol, generate: gen })
		const res = await cap.invoke(
			call({ system: 'APP', prompt: 'define run', context: 'learning' }, ['context:learning'])
		)
		// The app receives only the model output — never the fragment or composed prompt.
		expect(res).toEqual({ text: 'echo:define run' })
		// The model saw the host-composed learning fragment ahead of the app prompt.
		expect(gen.system).toContain('# Learning adaptation')
		expect(gen.system).toContain('Known interests: Minecraft.')
		expect(gen.system.trimEnd().endsWith('APP')).toBe(true)
	})

	test('without a volume, a scoped call still gates but composes no fragment', async () => {
		const gen = recordingGenerate()
		const cap = aiCapability({ generate: gen })
		await cap.invoke(
			call({ system: 'APP', prompt: 'hi', context: 'learning' }, ['context:learning'])
		)
		expect(gen.system).toBe('APP')
	})
})
