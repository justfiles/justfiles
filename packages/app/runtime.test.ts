import { expect, test } from 'bun:test'
import { Type } from 'typebox'
import { define as defineApp } from './app.js'
import { define as defineEngine } from './engine.js'
import { dispatch } from './runtime.js'

test('dispatch returns transition narration', () => {
	const app = defineApp({
		name: 'Test',
		description: 'Test app',
		engine: defineEngine({
			initial: 'init',
			context: {},
			states: {
				init: {
					on: {
						setup: {
							schema: Type.Object({ theme: Type.String() }),
							target: 'ready',
							narrate: ({ action }) => `setup ${(action.payload as { theme: string }).theme}`
						}
					}
				},
				ready: {}
			}
		})
	})

	const result = dispatch(
		app,
		{ state: 'init', context: {} },
		{ type: 'setup', payload: { theme: 'space' } },
		{ id: 'user' }
	)

	expect(result.ok).toBe(true)
	if (result.ok) expect(result.narration).toBe('setup space')
})
