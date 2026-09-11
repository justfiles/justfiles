import * as v from 'valibot'
import { volume } from '../capabilities/volume/index.ts'
import { defineApp } from '../sdk.ts'

// Procedures can read capabilities without committing, or dispatch and wait for
// reducer updates. Includes a GUI-only procedure to test action visibility.
type State = {
	files: Array<{ path: string }>
	loading: boolean
	error: string | null
}

const initialState: State = { files: [], loading: false, error: null }

const decoder = new TextDecoder()

export const app = defineApp({
	init: initialState,
	capabilities: { files: volume({ scopes: ['system'] }) },
	update: (t) => ({
		refresh: t.on(v.object({}), (state) => [
			{ ...state, loading: true, error: null },
			t.cmd('files', 'scan', { path: '/', recursive: true }).to('filesLoaded')
		]),
		filesLoaded: t.fromResult('files', 'scan', (state, r) =>
			r.ok
				? {
						...state,
						loading: false,
						error: null,
						files: r.value.filter((e) => e.type === 'file').map((e) => ({ path: e.path }))
					}
				: { ...state, loading: false, error: r.error.message }
		)
	}),
	procedures: (p) => ({
		// caller-scoped read — the value returns to the caller, never into state
		readFile: p.procedure({
			description: 'Read a file as text.',
			schema: v.object({ path: v.string() }),
			async run({ path }, app) {
				return decoder.decode(await app.cap.files.readFile(path))
			}
		}),
		// drive the reducer, then report the outcome by value (the settled count)
		refreshAndCount: p.procedure({
			description: 'Refresh, then report how many files were found.',
			schema: v.object({}),
			async run(_, app) {
				const { seq } = await app.dispatch({ type: 'refresh', params: {} })
				const s = await app.settled(seq, { timeout: 5000 })
				return { count: s.files.length }
			}
		}),
		// gui-only — hidden from the agent's tool list, still callable by the GUI
		fileCount: p.procedure({
			audience: 'gui',
			schema: v.object({}),
			run: (_, app) => app.state.files.length
		})
	})
})
