import { defineApp } from '@justfiles/app'
import { volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'

// Icon is a focused, file-based wrapper over Excalidraw. Scene bytes NEVER enter
// reducer state: the GUI re-reads them on open and autosaves them on change.
// Reducer state holds only "which icon project is open" plus the last error, so
// it stays small, legible, and agent-inspectable.
const enc = new TextEncoder()
const dec = new TextDecoder()

const EXT = '.excalidraw'
// The single unsaved scratch canvas. `openPath === null` means "editing this".
// Named icon projects are its slugged siblings; the draft is excluded from the list.
export const DRAFT_PATH = `/draft${EXT}`

// Filename = slug(name). An icon has no text to derive a title from, so named
// icons are named by the user: lowercase, non-alphanumerics collapse to `_`,
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

export type IconState = {
	openPath: string | null // null = the unsaved draft (bytes at DRAFT_PATH)
	error: string | null
}

// The shape `list` returns (never folded into state).
export type IconProject = { path: string; title: string }

const pathSchema = v.pipe(v.string(), v.minLength(1))

export const app = defineApp({
	init: { openPath: null, error: null } as IconState,
	capabilities: { volume: volume({ scopes: [] }) },

	update: (t) => ({
		open: t.on(
			v.object({ path: pathSchema }),
			(state, { path }) => ({ ...state, openPath: path, error: null }),
			{
				description: 'Open a saved icon project in the editor.',
				examples: [{ params: { path: '/app_icon.excalidraw' } }]
			}
		),
		newDraft: t.on(v.object({}), (state) => ({ ...state, openPath: null, error: null }), {
			description: 'Switch to a fresh, unsaved draft canvas.'
		}),

		// Autosave: write the scene JSON to the open icon project (or the draft). The GUI
		// dispatches this on a debounced pause, never per stroke.
		save: t.on(
			v.object({ path: pathSchema, json: v.string() }),
			(state, { path, json }) => [
				state,
				t.cmd('volume', 'writeFile', path, enc.encode(json)).to('saved')
			],
			{
				description: 'Overwrite an icon project with its Excalidraw scene JSON (autosave).',
				examples: [{ params: { path: DRAFT_PATH, json: '{"type":"excalidraw","elements":[]}' } }]
			}
		),
		saved: t.fromResult('volume', 'writeFile', (state, r) =>
			r.ok ? { ...state, error: null } : { ...state, error: r.error.message }
		)
	}),

	procedures: (p) => ({
		// The index of saved icon projects — scanned fresh, EXCLUDING the draft.
		list: p.procedure({
			description: 'List saved icon projects (path, title).',
			schema: v.object({}),
			async run(_params, app): Promise<IconProject[]> {
				const entries = await app.cap.volume.scan({ path: '/' })
				return entries
					.filter((e) => e.type === 'file' && e.path.endsWith(EXT) && e.path !== DRAFT_PATH)
					.map((e) => ({ path: e.path, title: e.path.slice(1, -EXT.length) }))
					.sort((a, b) => a.title.localeCompare(b.title))
			}
		}),

		// Read a scene's JSON back to the GUI (empty string when the file is absent).
		readScene: p.procedure({
			description: 'Read an icon project’s Excalidraw scene JSON.',
			audience: 'gui',
			schema: v.object({ path: pathSchema }),
			async run({ path }, app): Promise<{ path: string; json: string }> {
				if (!(await app.cap.volume.exists(path))) return { path, json: '' }
				return { path, json: dec.decode(await app.cap.volume.readFile(path)) }
			}
		}),

		// Save the current draft as a named icon project: write it as a deduped named
		// file, then clear the draft. Returns the new path so the GUI can open it.
		// GUI-only — it carries the live scene and deletes the draft, neither of
		// which the agent should drive blindly.
		promote: p.procedure({
			description: 'Save the current draft as a named icon project; returns its path.',
			audience: 'gui',
			schema: v.object({ name: v.string(), json: v.string() }),
			async run({ name, json }, app): Promise<{ path: string }> {
				const path = await freePath(slug(name), (probe) => app.cap.volume.exists(probe))
				await app.cap.volume.writeFile(path, enc.encode(json))
				await app.cap.volume.rm(DRAFT_PATH, { force: true })
				return { path }
			}
		})
	})
})

export type IconApp = typeof app
