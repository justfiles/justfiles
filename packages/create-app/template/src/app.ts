import { defineApp } from '@justfiles/app'
import * as v from 'valibot'

export const app = defineApp({
	init: { count: 0 },
	update: (t) => ({
		increment: t.on(
			v.object({ amount: v.number() }),
			(state, { amount }) => ({ ...state, count: state.count + amount }),
			{ description: 'Increase the counter.', examples: [{ params: { amount: 1 } }] }
		)
	})
})

// ALWAYS export the type — the GUI and clients infer everything from it.
export type CounterApp = typeof app
