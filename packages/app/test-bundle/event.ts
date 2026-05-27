import * as v from 'valibot'
import { defineCapability } from '../capabilities/core.ts'
import { defineApp } from '../sdk.ts'

interface TickerMethods {
	noop(input: Record<string, never>): Promise<void>
}

// Declared events: payload types flow into the app's `on`-handlers.
interface TickerEvents {
	tick: { delta: number }
	reset: { reason: string }
}

const ticker = defineCapability<'ticker', TickerMethods, TickerEvents>('ticker')

export const app = defineApp({
	init: { count: 0, lastReason: null as string | null },
	capabilities: { ticker: ticker({ scopes: [] }) },
	actions: (b) => ({
		bump: b.handler({
			schema: v.object({ by: v.number() }),
			handler({ by }, ctx) {
				return { ...ctx.state, count: ctx.state.count + by }
			}
		})
	}),
	on: {
		ticker: {
			tick: (event, ctx) => ({ ...ctx.state, count: ctx.state.count + event.delta }),
			reset: (event, _ctx) => ({ count: 0, lastReason: event.reason })
		}
	}
})
