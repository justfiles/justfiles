import { defineApp } from '@justfiles/app/kernel/sdk'
import * as v from 'valibot'

export const app = defineApp({
	init: { count: 0 },
	handlers: {
		increment: {
			description: 'Increase the counter.',
			schema: v.object({ amount: v.number() }),
			examples: [{ params: { amount: 1 } }],
			handler({ amount }, ctx) {
				return { count: ctx.state.count + amount }
			}
		}
	}
})

export type ExampleApp = typeof app
