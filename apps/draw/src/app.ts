import { defineApp } from '@justfiles/app'
import { volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'

// Draw is a thin, file-based wrapper over Excalidraw. Everything lives in the
// app's private volume (`/data/app.justfiles.frieren.draw`). Scene bytes (an Excalidraw
// scene JSON) NEVER enter reducer state — the GUI re-reads them on open and
// autosaves them on change, exactly like app-notes' body text. Reducer state
// holds only the semantic fact "which drawing is open" plus the last error, so
// it stays small, legible, and agent-inspectable.
const enc = new TextEncoder()
const dec = new TextDecoder()

const EXT = '.excalidraw'
// The single unsaved scratch canvas. `openPath === null` means "editing this".
// Named drawings are its slugged siblings; the draft is excluded from the list.
export const DRAFT_PATH = `/draft${EXT}`

// Filename = slug(name). A drawing has no text to derive a title from, so named
// drawings are named by the user: lowercase, non-alphanumerics collapse to `_`,
// ends trimmed, length-capped; empty input falls back to `untitled`.
function slug(input: string): string {
	const out = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 60)
		.replace(/_+$/g, '')
	return out || 'untitled'
}

// Dedup a slug with an `exists()` probe — `/x.excalidraw`, `/x_2.excalidraw`, …
async function freePath(base: string, exists: (path: string) => Promise<boolean>): Promise<string> {
	const first = `/${base}${EXT}`
	if (!(await exists(first))) return first
	for (let n = 2; ; n++) {
		const candidate = `/${base}_${n}${EXT}`
		if (!(await exists(candidate))) return candidate
	}
}

export type DrawState = {
	openPath: string | null // null = the unsaved draft (bytes at DRAFT_PATH)
	error: string | null
}

// The shape `list` returns (never folded into state).
export type Drawing = { path: string; title: string }

const pathSchema = v.pipe(v.string(), v.minLength(1))

export const app = defineApp({
	init: { openPath: null, error: null } as DrawState,
	capabilities: { volume: volume({ scopes: [] }) },

	update: (t) => ({
		open: t.on(
			v.object({ path: pathSchema }),
			(state, { path }) => ({ ...state, openPath: path, error: null }),
			{
				description: 'Open a saved drawing in the editor.',
				examples: [{ params: { path: '/floor_plan.excalidraw' } }]
			}
		),
		newDraft: t.on(v.object({}), (state) => ({ ...state, openPath: null, error: null }), {
			description: 'Switch to a fresh, unsaved draft canvas.'
		}),

		// Autosave: write the scene JSON to the open drawing (or the draft). The GUI
		// dispatches this on a debounced pause, never per stroke.
		save: t.on(
			v.object({ path: pathSchema, json: v.string() }),
			(state, { path, json }) => [
				state,
				t.cmd('volume', 'writeFile', path, enc.encode(json)).to('saved')
			],
			{
				description: 'Overwrite a drawing file with an Excalidraw scene JSON (autosave).',
				examples: [{ params: { path: DRAFT_PATH, json: '{"type":"excalidraw","elements":[]}' } }]
			}
		),
		saved: t.fromResult('volume', 'writeFile', (state, r) =>
			r.ok ? { ...state, error: null } : { ...state, error: r.error.message }
		)
	}),

	procedures: (p) => ({
		// The index of saved drawings — scanned fresh, EXCLUDING the draft.
		list: p.procedure({
			description: 'List saved drawings (path, title).',
			schema: v.object({}),
			async run(_params, app): Promise<Drawing[]> {
				const entries = await app.invoke('volume', 'scan', { path: '/' })
				return entries
					.filter((e) => e.type === 'file' && e.path.endsWith(EXT) && e.path !== DRAFT_PATH)
					.map((e) => ({ path: e.path, title: e.path.slice(1, -EXT.length) }))
					.sort((a, b) => a.title.localeCompare(b.title))
			}
		}),

		// Read a scene's JSON back to the GUI (empty string when the file is absent).
		readScene: p.procedure({
			description: 'Read a drawing’s Excalidraw scene JSON.',
			audience: 'gui',
			schema: v.object({ path: pathSchema }),
			async run({ path }, app): Promise<{ path: string; json: string }> {
				if (!(await app.invoke('volume', 'exists', path))) return { path, json: '' }
				return { path, json: dec.decode(await app.invoke('volume', 'readFile', path)) }
			}
		}),

		// Save the current draft as a named drawing: write it as a deduped named
		// file, then clear the draft. Returns the new path so the GUI can open it.
		// GUI-only — it carries the live scene and deletes the draft, neither of
		// which the agent should drive blindly.
		promote: p.procedure({
			description: 'Save the current draft as a named drawing; returns its path.',
			audience: 'gui',
			schema: v.object({ name: v.string(), json: v.string() }),
			async run({ name, json }, app): Promise<{ path: string }> {
				const path = await freePath(slug(name), (probe) => app.invoke('volume', 'exists', probe))
				await app.invoke('volume', 'writeFile', path, enc.encode(json))
				await app.invoke('volume', 'rm', DRAFT_PATH, { force: true })
				return { path }
			}
		})
	})
})

export type DrawApp = typeof app
