import { defineApp } from '@justfiles/app'
import { volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'
import {
	firstLine,
	isNotePath,
	isUnder,
	joinPath,
	NOTE_EXT,
	noteTitle,
	sanitizeName
} from './notes.ts'

// Notes live in the shared, top-level `/notes` knowledge base (DESIGN.md §1–2).
// A `/notes` prefix scope chroots the app there — its `/` IS `/notes` — while
// still hard-blocking `/system`. So every path in this file is plain
// root-relative: `/Remember the milk.md` lands at `/notes/Remember the milk.md`.
const enc = new TextEncoder()
const dec = new TextDecoder()

// Dedup a name with an `exists()` probe — `Kyoto.md`, `Kyoto 2.md`, … There is
// no cached list to consult; the disk is the only source of truth (DESIGN.md §3).
async function freePath(
	dir: string,
	base: string,
	exists: (path: string) => Promise<boolean>
): Promise<string> {
	const first = joinPath(dir, `${base}${NOTE_EXT}`)
	if (!(await exists(first))) return first
	for (let n = 2; ; n++) {
		const candidate = joinPath(dir, `${base} ${n}${NOTE_EXT}`)
		if (!(await exists(candidate))) return candidate
	}
}

// Reducer state holds only the app-session facts that survive reload and that
// the agent should read: which note is open, change counters for the open file
// and for the tree, and the last error. Body bytes and the note list are NOT
// here — both are re-read from disk on demand (DESIGN.md §3).
export type NotesState = {
	openPath: string | null
	revision: number
	treeRevision: number
	error: string | null
}

// The shape `list` returns (never folded into state). Folders are included so
// the tree can show empty ones and CRUD has something to act on.
export type Entry = { path: string; type: 'file' | 'dir'; title: string; mtime: number }

export const initialState: NotesState = {
	openPath: null,
	revision: 0,
	treeRevision: 0,
	error: null
}

const pathSchema = v.pipe(v.string(), v.minLength(1))

export const app = defineApp({
	init: initialState,
	capabilities: { volume: volume({ scopes: ['/notes'] }) },

	// Two watches, two signals (DESIGN.md §3): the open file keeps its body live
	// when the agent or Files edits it on disk, and a recursive watch is the
	// structural signal — a create/remove/rename anywhere means the tree the user
	// is looking at is stale. Neither carries data; `list`/`readNote` re-read.
	subscriptions: (state, sub) => [
		sub.capability('volume', 'watch', { path: '/', recursive: true }).to('treeChanged'),
		...(state.openPath
			? [sub.capability('volume', 'watch', { path: state.openPath }).to('fileChanged')]
			: [])
	],

	update: (t) => ({
		// — pure mutations (agent-visible) —
		open: t.on(
			v.object({ path: pathSchema }),
			(state, { path }) => ({ ...state, openPath: path, error: null }),
			{
				description: 'Open a note in the editor — surfaces it in the user’s window.',
				examples: [{ params: { path: '/Remember the milk.md' } }]
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
				examples: [{ params: { path: '/Groceries.md', text: 'eggs, milk' } }]
			}
		),
		saved: t.fromResult('volume', 'writeFile', (state, r) =>
			r.ok ? { ...state, error: null } : { ...state, error: r.error.message }
		),

		// — rename IS move: one op covers retitling, dragging into a folder, and
		// renaming a folder. `openPath` follows the moved file, or the moved folder
		// it lives under.
		rename: t.on(
			v.object({ from: pathSchema, to: pathSchema }),
			(state, { from, to }) => {
				const openPath =
					state.openPath && isUnder(state.openPath, from)
						? `${to}${state.openPath.slice(from.length)}`
						: state.openPath
				return [{ ...state, openPath }, t.cmd('volume', 'rename', from, to).to('renamed')]
			},
			{
				description:
					'Rename or move a note or folder. `to` is the full destination path, so this also moves a note into another folder.',
				examples: [{ params: { from: '/Groceries.md', to: '/Lists/Shopping list.md' } }]
			}
		),
		renamed: t.fromResult('volume', 'rename', (state, r) =>
			r.ok ? state : { ...state, error: r.error.message }
		),

		// — external change to the OPEN file (the agent or Files edits it on disk) —
		fileChanged: t.fromEvent('volume', 'watch', (state) => ({
			...state,
			revision: state.revision + 1
		})),
		// — something was created/removed/renamed somewhere in `/notes` —
		treeChanged: t.fromEvent('volume', 'watch', (state) => ({
			...state,
			treeRevision: state.treeRevision + 1
		}))
	}),

	procedures: (p) => ({
		// The index — scanned fresh, RETURNED to the caller, never cached. One
		// recursive `scan` (the host walks the volume in a single round trip and
		// hands back mtimes), so nesting costs nothing extra.
		list: p.procedure({
			description:
				'List the knowledge base: every note (newest first) plus every folder, with path, title and mtime.',
			schema: v.object({}),
			async run(_params, app) {
				const entries = await app.invoke('volume', 'scan', { path: '/', recursive: true })
				const out: Entry[] = []
				for (const entry of entries) {
					if (entry.type === 'file' && !isNotePath(entry.path)) continue
					out.push({
						path: entry.path,
						type: entry.type,
						title: noteTitle(entry.path),
						mtime: entry.mtimeNs ?? 0
					})
				}
				return out.sort((a, b) => b.mtime - a.mtime)
			}
		}),

		// Create a note from text; filename = the first line, kept human (case and
		// spaces preserved), deduped. `dir` defaults to the vault root; the GUI
		// passes the open note's folder so new notes land beside their sibling.
		create: p.procedure({
			description:
				'Create a note from text; its filename is the first line, e.g. "Remember the milk" → /Remember the milk.md. Pass `dir` to create it inside a folder.',
			schema: v.object({ text: v.string(), dir: v.optional(pathSchema) }),
			async run({ text, dir }, app) {
				const path = await freePath(dir ?? '/', sanitizeName(firstLine(text)), (probe) =>
					app.invoke('volume', 'exists', probe)
				)
				await app.invoke('volume', 'writeFile', path, enc.encode(text))
				const { seq } = await app.dispatch({ type: 'open', params: { path } })
				return app.settled(seq)
			}
		}),

		// Folders are ordinary directories; `writeFile` auto-creates parents, so
		// this exists only to make an EMPTY folder.
		mkdir: p.procedure({
			description: 'Create a folder, e.g. "/Trips".',
			schema: v.object({ path: pathSchema }),
			async run({ path }, app) {
				await app.invoke('volume', 'mkdir', path, { recursive: true })
			}
		}),

		readNote: p.procedure({
			description: 'Read a note’s body as text, e.g. path "/Remember the milk.md".',
			schema: v.object({ path: pathSchema }),
			async run({ path }, app) {
				if (!(await app.invoke('volume', 'exists', path))) return { path, text: '' }
				return { path, text: dec.decode(await app.invoke('volume', 'readFile', path)) }
			}
		}),

		// Destructive — gui-only. `/notes` is the user's; the agent never deletes
		// user notes blindly (mirrors app-code's gui-only `remove`). DESIGN.md §6.
		remove: p.procedure({
			description: 'Delete a note, or a folder and everything in it.',
			audience: 'gui',
			schema: v.object({ path: pathSchema }),
			async run({ path }, app) {
				await app.invoke('volume', 'rm', path, { force: true, recursive: true })
				if (app.state.openPath && isUnder(app.state.openPath, path)) {
					const { seq } = await app.dispatch({ type: 'newNote', params: {} })
					await app.settled(seq)
				}
			}
		})
	})
})

export type NotesApp = typeof app
