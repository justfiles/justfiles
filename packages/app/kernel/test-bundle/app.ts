import * as v from 'valibot'
import { defineCapability } from '../../capabilities/core.ts'
import { defineApp } from '../sdk.ts'

interface TestCapability {
	echo(input: { text: string }): Promise<{ text: string }>
}

const test = defineCapability<'test', TestCapability>('test')

export const app = defineApp({
	init: { count: 0 },
	capabilities: { test: test({ scopes: [] }) },
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
		},
		ask: {
			schema: v.object({ text: v.string() }),
			async handler({ text }, ctx) {
				const result = await ctx.capabilities.test.echo({ text })
				return { count: result.text.length }
			}
		}
	}
})
