import { expect, test } from 'bun:test'
import { Type } from 'typebox'
import { define as defineApp } from './app.js'
import { engine } from './engine.js'
import { dispatch } from './runtime.js'

test('dispatch returns transition narration', () => {
	const app = defineApp({
		name: 'Test',
		description: 'Test app',
		engine: engine().build({
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

test('target function chooses the next state from post-action context', () => {
	const app = defineApp({
		name: 'Branching',
		description: 'Branching test app',
		engine: engine().build({
			initial: 'a' as 'a' | 'b' | 'c',
			context: { n: 0 },
			states: {
				a: {
					on: {
						bump: {
							schema: Type.Object({ by: Type.Number() }),
							target: ({ context }) => (context.n >= 10 ? 'c' : 'b'),
							actions: ({ context, action }) => ({
								n: context.n + (action.payload as { by: number }).by
							})
						}
					}
				},
				b: {},
				c: {}
			}
		})
	})

	const small = dispatch(
		app,
		{ state: 'a', context: { n: 0 } },
		{ type: 'bump', payload: { by: 1 } },
		{ id: 'u' }
	)
	expect(small.ok).toBe(true)
	if (small.ok) {
		expect(small.next.state).toBe('b')
		expect(small.next.context.n).toBe(1)
	}

	const big = dispatch(
		app,
		{ state: 'a', context: { n: 5 } },
		{ type: 'bump', payload: { by: 7 } },
		{ id: 'u' }
	)
	expect(big.ok).toBe(true)
	if (big.ok) {
		expect(big.next.state).toBe('c')
		expect(big.next.context.n).toBe(12)
	}
})
