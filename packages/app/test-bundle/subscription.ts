import * as v from 'valibot'
import { volume } from '../capabilities/volume/index.ts'
import { defineApp } from '../sdk.ts'

// Part D sample app: declares a `volume.watch` stream as a pure function of
// state. `open` sets the watched path (so the kernel starts a stream), `close`
// clears it (the kernel stops it), and `changed` folds each emitted event.
export type WatchState = {
	watching: string | null
	events: number
	lastSource: string | null
}

export const initialState: WatchState = { watching: null, events: 0, lastSource: null }

export const app = defineApp({
	init: initialState,
	capabilities: { volume: volume({ scopes: ['system'] }) },
	subscriptions: (state, sub) =>
		state.watching
			? [sub.capability('volume', 'watch', { path: state.watching }).to('changed')]
			: [],
	update: (t) => ({
		open: t.on(v.object({ path: v.string() }), (state, { path }) => ({ ...state, watching: path })),
		close: t.on(v.object({}), (state) => ({ ...state, watching: null })),
		// a stream event — payload typed from the `volume.watch` contract
		changed: t.fromEvent('volume', 'watch', (state, event) => ({
			...state,
			events: state.events + 1,
			lastSource: event.source ?? null
		}))
	})
})
