import { defineApp } from '@justfiles/app/kernel/sdk'
import * as v from 'valibot'

export const app = defineApp({
	init: { count: 0 },
	handlers: {
		increment: {
			description: 'Increase the counter.',
			schema: v.object({ amount: v.number() }),
			examples: [{ params: { amount: 2 } }],
			handler({ amount }, ctx) {
				return { ...ctx.state, count: ctx.state.count + amount }
			}
		},
		decrement: {
			description: 'Decrease the counter.',
			schema: v.object({ amount: v.number() }),
			examples: [{ params: { amount: 1 } }],
			handler({ amount }, ctx) {
				return { ...ctx.state, count: ctx.state.count - amount }
			}
		}
	}
})

// The app's contract — the GUI client infers everything from this type.
export type HelloApp = typeof app
