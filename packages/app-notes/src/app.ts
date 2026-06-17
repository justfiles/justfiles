import { defineApp } from '@justfiles/app'
import { volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'

// Notes live in the shared, top-level `/notes` knowledge base (DESIGN.md §1–2).
// A `/notes` prefix scope chroots the app there — its `/` IS `/notes` — while
// still hard-blocking `/system`. So every path in this file is plain
// root-relative: `/remember_the_milk.txt` lands at `/notes/remember_the_milk.txt`.
const enc = new TextEncoder()
const dec = new TextDecoder()

const SLUG_MAX = 60

// Filename = slug(first non-empty line) — no AI (DESIGN.md §4). Lowercase, runs
// of non-alphanumerics collapse to `_`, ends trimmed, length-capped; empty input
// falls back to `untitled`. Exported for the GUI's title display.
export function slug(input: string): string {
	const out = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, SLUG_MAX)
		.replace(/_+$/g, '')
	return out || 'untitled'
}

function firstLine(text: string): string {
	for (const line of text.split('\n')) {
		const trimmed = line.trim()
		if (trimmed) return trimmed
	}
	return ''
}

// Dedup a slug with an `exists()` probe — `/x.txt`, `/x_2.txt`, … There is no
// cached list to consult; the disk is the only source of truth (DESIGN.md §3).
async function freePath(base: string, exists: (path: string) => Promise<boolean>): Promise<string> {
	const first = `/${base}.txt`
	if (!(await exists(first))) return first
	for (let n = 2; ; n++) {
		const candidate = `/${base}_${n}.txt`
		if (!(await exists(candidate))) return candidate
	}
}

// Reducer state holds only the app-session facts that survive reload and that
// the agent should read: which note is open, a change counter for the open file,
// and the last error. Body bytes and the note list are NOT here — both are
// re-read from disk on demand (DESIGN.md §3).
export type NotesState = {
	openPath: string | null
	revision: number
	error: string | null
}

// The shape `list` returns (never folded into state).
export type Note = { path: string; title: string; mtime: number }

export const initialState: NotesState = { openPath: null, revision: 0, error: null }

const pathSchema = v.pipe(v.string(), v.minLength(1))

export const app = defineApp({
	init: initialState,
	capabilities: { volume: volume({ scopes: ['/notes'] }) },

	// Watch ONLY the open file, so its body stays live when the agent or Files
	// edits it on disk. The folder is not watched and the listing is not cached —
	// `list` re-scans `/notes` fresh whenever the palette opens (DESIGN.md §3).
	subscriptions: (state, sub) =>
		state.openPath
			? [sub.capability('volume', 'watch', { path: state.openPath }).to('fileChanged')]
			: [],

	update: (t) => ({
		// — pure mutations (agent-visible) —
		open: t.on(
			v.object({ path: pathSchema }),
			(state, { path }) => ({ ...state, openPath: path, error: null }),
			{
				description: 'Open a note in the editor — surfaces it in the user’s window.',
				examples: [{ params: { path: '/remember_the_milk.txt' } }]
			}
		),
		newNote: t.on(v.object({}), (state) => ({ ...state, openPath: null, error: null }), {
			description: 'Start a fresh blank note (clears the editor).'
		}),

		// — autosave for an existing note (the GUI dispatches on a debounced pause) —
		save: t.on(
			v.object({ path: pathSchema, text: v.string() }),
			(state, { path, text }) => [
				state,
				t.cmd('volume', 'writeFile', path, enc.encode(text)).to('saved')
			],
			{
				description: 'Overwrite a note’s body.',
				examples: [{ params: { path: '/groceries.txt', text: 'eggs, milk' } }]
			}
		),
		saved: t.fromResult('volume', 'writeFile', (state, r) =>
			r.ok ? { ...state, error: null } : { ...state, error: r.error.message }
		),

		// — rename = re-slug + move the file (only fixes openPath; no cached list) —
		rename: t.on(
			v.object({ from: pathSchema, title: v.string() }),
			(state, { from, title }) => {
				const to = `/${slug(title)}.txt`
				return [
					{ ...state, openPath: state.openPath === from ? to : state.openPath },
					t.cmd('volume', 'rename', from, to).to('renamed')
				]
			},
			{
				description: 'Rename a note (its filename is derived from the new title).',
				examples: [{ params: { from: '/groceries.txt', title: 'Shopping list' } }]
			}
		),
		renamed: t.fromResult('volume', 'rename', (state, r) =>
			r.ok ? state : { ...state, error: r.error.message }
		),

		// — external change to the OPEN file (the agent or Files edits it on disk) —
		fileChanged: t.fromEvent('volume', 'watch', (state) => ({
			...state,
			revision: state.revision + 1
		}))
	}),

	procedures: (p) => ({
		// The recency index — scanned fresh, RETURNED to the caller, never cached.
		list: p.procedure({
			description: 'List notes newest-first (path, title, mtime).',
			schema: v.object({}),
			async run(_params, app) {
				const entries = await app.invoke('volume', 'scan', { path: '/' })
				const notes: Note[] = []
				for (const entry of entries) {
					if (entry.type !== 'file' || !entry.path.endsWith('.txt')) continue
					const stat = await app.invoke('volume', 'stat', entry.path)
					notes.push({
						path: entry.path,
						title: entry.path.slice(1, -4),
						mtime: Number(stat.mtimeNs)
					})
				}
				return notes.sort((a, b) => b.mtime - a.mtime)
			}
		}),

		// Create a note from text; filename = slug of the first line, deduped.
		create: p.procedure({
			description:
				'Create a note from text; its filename is the slug of the first line, e.g. "Remember the milk" → /remember_the_milk.txt.',
			schema: v.object({ text: v.string() }),
			async run({ text }, app) {
				const path = await freePath(slug(firstLine(text)), (probe) =>
					app.invoke('volume', 'exists', probe)
				)
				await app.invoke('volume', 'writeFile', path, enc.encode(text))
				const { seq } = await app.dispatch({ type: 'open', params: { path } })
				return app.settled(seq)
			}
		}),

		readNote: p.procedure({
			description: 'Read a note’s body as text, e.g. path /remember_the_milk.txt.',
			schema: v.object({ path: pathSchema }),
			async run({ path }, app) {
				if (!(await app.invoke('volume', 'exists', path))) return { path, text: '' }
				return { path, text: dec.decode(await app.invoke('volume', 'readFile', path)) }
			}
		}),

		// Destructive — gui-only. `/notes` is the user's; the agent never deletes
		// user notes blindly (mirrors app-code's gui-only `remove`). DESIGN.md §6.
		remove: p.procedure({
			description: 'Delete a note.',
			audience: 'gui',
			schema: v.object({ path: pathSchema }),
			async run({ path }, app) {
				await app.invoke('volume', 'rm', path, { force: true })
			}
		})
	})
})

export type NotesApp = typeof app
