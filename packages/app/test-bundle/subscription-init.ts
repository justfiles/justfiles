import { volume } from '../capabilities/volume/index.ts'
import { defineApp } from '../sdk.ts'

// A subscription declared UNCONDITIONALLY (state-independent), so the `init`
// state already wants it. Exercises the install/boot warm path: the stream must
// come up on install alone, with no state() snapshot or dispatch.
export const app = defineApp({
	init: { events: 0 },
	capabilities: { volume: volume({ scopes: ['system'] }) },
	subscriptions: (_state, sub) => [
		sub.capability('volume', 'watch', { path: '/fixed' }).to('changed')
	],
	update: (t) => ({
		changed: t.fromEvent('volume', 'watch', (s) => ({ ...s, events: s.events + 1 }))
	})
})
