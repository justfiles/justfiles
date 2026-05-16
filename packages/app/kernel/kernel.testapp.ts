import { defineApp } from './sdk.ts'

export const app = defineApp({
  init: { count: 0 },
  handler: {
    increment({ amount }: { amount: number }, ctx) {
      return { ...ctx.state, count: ctx.state?.count ?? 0 + amount }
    },
    async write({ text }: { text: string }, ctx) {
      await ctx.files.writeFile('/note.txt', new TextEncoder().encode(text))
      return ctx.state!
    },
  },
})
