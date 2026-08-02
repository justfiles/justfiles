import * as v from 'valibot'
import { volume } from '../capabilities/volume/index.ts'
import { defineApp } from '../sdk.ts'

// The shape every tree-browsing app has (Files, Notes): an always-live recursive
// watch on the volume root whose edge COMMITS (bumping a revision the GUI keys a
// re-list on). The wake carries nothing, so the stream declares `.coalesce()` —
// which is exactly what this bundle exists to exercise end to end.
export type TreeState = { treeRevision: number; wakes: number }

export const initialState: TreeState = { treeRevision: 0, wakes: 0 }

export const app = defineApp({
	init: initialState,
	capabilities: { volume: volume({ scopes: ['system'] }) },
	subscriptions: (_state, sub) => [
		sub.capability('volume', 'watch', { path: '/', recursive: true }).coalesce().to('treeChanged')
	],
	update: (t) => ({
		// Committing on every wake is the point: it is what made a bulk fs operation
		// write state (and queue a dispatch) once per entry.
		treeChanged: t.fromEvent('volume', 'watch', (state) => ({
			...state,
			treeRevision: state.treeRevision + 1,
			wakes: state.wakes + 1
		})),
		noop: t.on(v.object({}), (state) => state)
	})
})
