import * as v from 'valibot'
import { volume } from '../capabilities/volume/index.ts'
import { defineApp } from '../sdk.ts'

// Pure-core (Part A) sample app: the Files `refresh` flow expressed as one
// `update` table. Every entry is a pure edge — no `ctx`, no `await`, no
// capabilities. The single side effect (`scan`) is emitted as command data.
export type CoreState = {
	files: Array<{ path: string }>
	loading: boolean
	error: string | null
}

export const initialState: CoreState = { files: [], loading: false, error: null }

export const app = defineApp({
	init: initialState,
	capabilities: { volume: volume({ scopes: ['system'] }) },
	update: (t) => ({
		// public edge — has a schema, so it IS the external API
		refresh: t.on(v.object({}), (state) => [
			{ ...state, loading: true, error: null },
			t.cmd('volume', 'scan', { path: '/', recursive: true }).to('filesLoaded')
		]),
		// internal commit edge — a procedure dispatches this by name to commit a
		// value it computed off to the side. Validated like `on`, but kept off the
		// public/agent action surface (only the app's own procedures reach it).
		loaded: t.commit(
			v.object({ files: v.array(v.object({ path: v.string() })) }),
			(state, { files }) => ({ ...state, loading: false, error: null, files })
		),
		// internal edge — fed by a capability result; `r` is typed from volume.scan
		filesLoaded: t.fromResult('volume', 'scan', (state, r) =>
			r.ok
				? {
						...state,
						loading: false,
						error: null,
						files: r.value.filter((e) => e.type === 'file').map((e) => ({ path: e.path }))
					}
				: { ...state, loading: false, error: r.error.message }
		)
	})
})
