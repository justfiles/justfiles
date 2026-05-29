import { defineApp } from '@justfiles/app'
import * as v from 'valibot'

export const app = defineApp({
	init: { count: 0 },
	actions: (b) => ({
		increment: b.handler({
			description: 'Increase the counter.',
			schema: v.object({ amount: v.number() }),
			examples: [{ params: { amount: 1 } }],
			handler({ amount }, ctx) {
				return { ...ctx.state, count: ctx.state.count + amount }
			}
		})
	})
})

export type ExampleApp = typeof app
