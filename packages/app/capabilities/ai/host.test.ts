import { describe, expect, test } from 'vitest'
import { type ContextComposers, composeSystem } from './host.ts'

const scoped = { scopes: ['context:learning'] }
const noScope = { scopes: [] as string[] }
const composers: ContextComposers = { learning: async () => '# Learning adaptation\n\nfragment' }

describe('composeSystem (ai context permission boundary)', () => {
	test('a context-free call returns the app system prompt unchanged', async () => {
		expect(await composeSystem(noScope, { system: 'APP' }, composers)).toBe('APP')
		expect(await composeSystem(noScope, {}, composers)).toBe('')
	})

	test('context: learning requires the context:learning scope', async () => {
		await expect(
			composeSystem(noScope, { system: 'APP', context: 'learning' }, composers)
		).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
	})

	test('with the scope, the composed fragment is prepended before the app prompt', async () => {
		const out = await composeSystem(scoped, { system: 'APP', context: 'learning' }, composers)
		expect(out).toBe('# Learning adaptation\n\nfragment\n\nAPP')
	})

	test('a neutral (empty) fragment leaves the app prompt untouched', async () => {
		const out = await composeSystem(
			scoped,
			{ system: 'APP', context: 'learning' },
			{
				learning: async () => ''
			}
		)
		expect(out).toBe('APP')
	})

	test('an unknown context value is INVALID_INPUT (the union is not an open string)', async () => {
		await expect(
			composeSystem(scoped, { system: 'APP', context: 'writing' }, composers)
		).rejects.toMatchObject({ code: 'CAPABILITY_INVALID_INPUT' })
	})
})
