import { defineApp } from '@justfiles/app'
import { volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'

// State is intentionally minimal — only what's worth persisting across
// reloads. The reliable durable fact is "what is the user looking at"; the
// bytes at that path can change underneath us, so they belong to a query
// that re-reads on demand (think `cat /path/to/file`).
export type FilesState = {
	currentViewing: string | null
	// Bumped each time the watched file changes on disk (Part D). The GUI keys its
	// preview re-read on it, so an external edit refreshes the open file.
	revision: number
	files: Array<{ path: string }>
	loading: boolean
	// Single-flight trailing edge: a structural change arrived while a scan was in
	// flight, so re-scan once the current one lands. Collapses bursts into one
	// extra pass rather than a scan per event.
	rescanPending: boolean
	error: string | null
}

export const initialState: FilesState = {
	currentViewing: null,
	revision: 0,
	files: [],
	loading: true,
	rescanPending: false,
	error: null
}

// Cap what the readFile query returns. 256 KiB is enough for inspecting
// source/text files; binary previews are out of scope here.
const PREVIEW_LIMIT = 256 * 1024
const decoder = new TextDecoder()

const pathSchema = v.pipe(
	v.string(),
	v.minLength(1),
	v.regex(/^\//, 'path must be absolute'),
	v.check((path) => !path.split('/').includes('..'), 'path may not contain ..')
)

export const app = defineApp({
	init: initialState,
	capabilities: { volume: volume({ scopes: ['system'] }) },
	// Two watches, both pure functions of state (Part D). The recursive one is
	// always live: it reports structural changes anywhere in the volume so the tree
	// auto-refreshes (folds via `treeChanged`). The single-path one tracks the open
	// file's bytes for the preview, kept alive only while `currentViewing` holds.
	subscriptions: (state, sub) => [
		sub.capability('volume', 'watch', { path: '/', recursive: true }).to('treeChanged'),
		...(state.currentViewing
			? [sub.capability('volume', 'watch', { path: state.currentViewing }).to('fileChanged')]
			: [])
	],
	// Every state transition is a pure edge. The one effect — scanning the
	// volume — is emitted as command data; its result folds back via `filesLoaded`.
	update: (t) => {
		const scan = () => t.cmd('volume', 'scan', { path: '/', recursive: true }).to('filesLoaded')
		return {
			refresh: t.on(v.object({}), (state) => [{ ...state, loading: true, error: null }, scan()], {
				description: 'Refresh the visible file list.'
			}),
			// The recursive watch fired: re-scan to pick up the new entry set. If a
			// scan is already running, just mark the result stale (`filesLoaded` will
			// chase it) so a burst collapses into a single trailing pass.
			treeChanged: t.fromEvent('volume', 'watch', (state) =>
				state.loading ? { ...state, rescanPending: true } : [{ ...state, loading: true }, scan()]
			),
			filesLoaded: t.fromResult('volume', 'scan', (state, r) => {
				if (!r.ok) return { ...state, loading: false, rescanPending: false, error: r.error.message }
				const files = r.value
					.filter((entry) => entry.type === 'file')
					.map((entry) => ({ path: entry.path }))
					.sort((a, b) => a.path.localeCompare(b.path))
				const stillThere = files.some((file) => file.path === state.currentViewing)
				const next = {
					...state,
					files,
					currentViewing: stillThere ? state.currentViewing : null,
					error: null
				}
				// A change landed mid-scan — fold the trailing edge into one more pass.
				return state.rescanPending
					? [{ ...next, rescanPending: false }, scan()]
					: { ...next, loading: false }
			}),
			setView: t.on(
				v.object({ path: pathSchema }),
				(state, { path }) => ({ ...state, currentViewing: path, error: null }),
				{ description: 'Record which file the user is currently viewing.' }
			),
			clear: t.on(v.object({}), (state) => ({ ...state, currentViewing: null, error: null }), {
				description: 'Clear the current Files selection.'
			}),
			// The watched file changed on disk — bump `revision` so the GUI re-reads it.
			// The bytes themselves never enter state (the preview is a caller-scoped
			// query); this is just the change signal.
			fileChanged: t.fromEvent('volume', 'watch', (state) => ({
				...state,
				revision: state.revision + 1
			}))
		}
	},
	// A caller-scoped read (Part C): the bytes return to the caller, never into
	// state. The kernel attaches the declared scopes to `app.invoke`.
	procedures: (p) => ({
		readFile: p.procedure({
			description: 'Read a file as text, capped at the preview limit.',
			schema: v.object({ path: pathSchema }),
			async run({ path }, app) {
				const bytes = await app.invoke('volume', 'readFile', path)
				const truncated = bytes.byteLength > PREVIEW_LIMIT
				const slice = truncated ? bytes.subarray(0, PREVIEW_LIMIT) : bytes
				// `size` is the full byte length on disk, not the (possibly capped)
				// preview slice — so the status bar reports the real file size.
				return { path, content: decoder.decode(slice), truncated, size: bytes.byteLength }
			}
		})
	})
})

export type FilesApp = typeof app
