import { defineApp } from './sdk.ts'

export const app = defineApp({
	init: { count: 0 },
	handlers: {
		increment({ amount }: { amount: number }, ctx) {
			return { ...ctx.state, count: ctx.state.count + amount }
		},
		async write({ text }: { text: string }, ctx) {
			await ctx.files.writeFile('/note.txt', new TextEncoder().encode(text))
			return ctx.state!
		}
	}
})
