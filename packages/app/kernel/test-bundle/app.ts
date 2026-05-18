import * as v from 'valibot'
import { defineApp } from '../sdk.ts'

export const app = defineApp({
	init: { count: 0 },
	handlers: {
		increment: {
			schema: v.object({ amount: v.number() }),
			handler({ amount }, ctx) {
				return { ...ctx.state, count: ctx.state.count + amount }
			}
		},
		write: {
			schema: v.object({ text: v.string() }),
			async handler({ text }, ctx) {
				await ctx.files.writeFile('/note.txt', new TextEncoder().encode(text))
				return ctx.state
			}
		}
	}
})
