import Type from 'typebox'
import { defineApp } from '../sdk.ts'

export const app = defineApp({
	init: { count: 0 },
	handlers: {
		increment: {
			schema: Type.Object({ amount: Type.Number() }),
			handler({ amount }, ctx) {
				return { ...ctx.state, count: ctx.state.count + amount }
			}
		},
		write: {
			schema: Type.Object({ text: Type.String() }),
			async handler({ text }, ctx) {
				await ctx.files.writeFile('/note.txt', new TextEncoder().encode(text))
				return ctx.state
			}
		}
	}
})
