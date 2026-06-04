import { defineApp } from '@justfiles/app'
import * as v from 'valibot'

export const app = defineApp({
	init: { count: 0 },
	update: (t) => ({
		increment: t.on(
			v.object({ amount: v.number() }),
			(state, { amount }) => ({ ...state, count: state.count + amount }),
			{ description: 'Increase the counter.', examples: [{ params: { amount: 2 } }] }
		),
		decrement: t.on(
			v.object({ amount: v.number() }),
			(state, { amount }) => ({ ...state, count: state.count - amount }),
			{ description: 'Decrease the counter.', examples: [{ params: { amount: 1 } }] }
		)
	})
})

// The app's contract — the GUI client infers everything from this type.
export type HelloApp = typeof app
