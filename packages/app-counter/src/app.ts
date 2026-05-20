import { defineApp } from '@justfiles/app/kernel/sdk'
import * as v from 'valibot'

export const app = defineApp({
	init: { count: 0 },
	handlers: {
		increment: {
			schema: v.object({ amount: v.number() }),
			handler({ amount }, ctx) {
				return { ...ctx.state, count: ctx.state.count + amount }
			}
		},
		decrement: {
			schema: v.object({ amount: v.number() }),
			handler({ amount }, ctx) {
				return { ...ctx.state, count: ctx.state.count - amount }
			}
		}
	}
})

// The app's contract — the GUI client infers everything from this type.
export type HelloApp = typeof app
