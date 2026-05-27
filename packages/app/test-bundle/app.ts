import * as v from 'valibot'
import { defineCapability } from '../capabilities/core.ts'
import { volume } from '../capabilities/volume/index.ts'
import { defineApp } from '../sdk.ts'

interface TestCapability {
	echo(input: { text: string }): Promise<{ text: string }>
}

const test = defineCapability<'test', TestCapability>('test')

export const app = defineApp({
	init: { count: 0 },
	capabilities: { test: test({ scopes: [] }), volume: volume({ scopes: ['app'] }) },
	actions: (b) => ({
		increment: b.handler({
			schema: v.object({ amount: v.number() }),
			handler({ amount }, ctx) {
				return { ...ctx.state, count: ctx.state.count + amount }
			}
		}),
		write: b.handler({
			schema: v.object({ text: v.string() }),
			async handler({ text }, ctx) {
				await ctx.capabilities.volume.writeFile({
					path: '/note.txt',
					data: new TextEncoder().encode(text)
				})
				return ctx.state
			}
		}),
		ask: b.handler({
			schema: v.object({ text: v.string() }),
			async handler({ text }, ctx) {
				const result = await ctx.capabilities.test.echo({ text })
				return { count: result.text.length }
			}
		})
	})
})
