import { defineApp } from '@justfiles/app'
import { volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'

// State is intentionally minimal — only what's worth persisting across
// reloads. The reliable durable fact is "what is the user looking at"; the
// bytes at that path can change underneath us, so they belong to a query
// that re-reads on demand (think `cat /path/to/file`).
export type FinderState = {
	currentViewing: string | null
	files: Array<{ path: string }>
	loading: boolean
	error: string | null
}

export const initialState: FinderState = {
	currentViewing: null,
	files: [],
	loading: true,
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
	actions: (b) => ({
		refresh: b.handler({
			description: 'Refresh the visible file list.',
			schema: v.object({}),
			async handler(_, ctx) {
				try {
					const entries = await ctx.capabilities.volume.scan({ path: '/', recursive: true })
					const files = entries
						.filter((entry) => entry.type === 'file')
						.map((entry) => ({ path: entry.path }))
						.sort((a, b) => a.path.localeCompare(b.path))
					const stillThere = files.some((file) => file.path === ctx.state.currentViewing)
					return {
						...ctx.state,
						files,
						currentViewing: stillThere ? ctx.state.currentViewing : null,
						loading: false,
						error: null
					}
				} catch (err) {
					return {
						...ctx.state,
						loading: false,
						error: err instanceof Error ? err.message : String(err)
					}
				}
			}
		}),
		setView: b.handler({
			description: 'Record which file the user is currently viewing.',
			schema: v.object({ path: pathSchema }),
			handler({ path }, ctx) {
				return { ...ctx.state, currentViewing: path, error: null }
			}
		}),
		clear: b.handler({
			description: 'Clear the current Finder selection.',
			schema: v.object({}),
			handler(_, ctx) {
				return { ...ctx.state, currentViewing: null, error: null }
			}
		})
	}),
	// A caller-scoped read (Part C): the bytes return to the caller, never into
	// state. The kernel attaches the declared scopes to `app.invoke`.
	procedures: (p) => ({
		readFile: p.procedure({
			description: 'Read a file as text, capped at the preview limit.',
			schema: v.object({ path: pathSchema }),
			async run({ path }, app) {
				const bytes = await app.invoke('volume', 'readFile', { path })
				const truncated = bytes.byteLength > PREVIEW_LIMIT
				const slice = truncated ? bytes.subarray(0, PREVIEW_LIMIT) : bytes
				return { path, content: decoder.decode(slice), truncated }
			}
		})
	})
})

export type FinderApp = typeof app
