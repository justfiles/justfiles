import { defineApp } from '@justfiles/app'
import { volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'
import {
	firstLine,
	illegalMove,
	isCanonicalPath,
	isNotePath,
	isUnder,
	joinPath,
	NOTE_EXT,
	namesEntry,
	noteTitle,
	numberedPath,
	sanitizeName
} from './notes.ts'

// Notes live in the shared, top-level `/notes` knowledge base (DESIGN.md §1–2).
// A `/notes` prefix scope chroots the app there — its `/` IS `/notes` — while
// still hard-blocking `/system`. So every path in this file is plain
// root-relative: `/Remember the milk.md` lands at `/notes/Remember the milk.md`.
const enc = new TextEncoder()
const dec = new TextDecoder()

// Claim a free path by CREATING it — `Kyoto.md`, `Kyoto 2.md`, … keeping the
// extension. The claim is the write itself, never an `exists()` probe followed by a
// write: that is a TOCTOU, and another writer (the agent, Files, a second window)
// taking the name in between would have its note overwritten. `create` is atomic in
// the backend, so the filesystem decides the winner and the loser just numbers up.
// Used by create, move and import — the single reason nothing in `/notes` is ever
// silently overwritten (DESIGN.md §3).
// Procedures run OFF the kernel's per-app queue (packages/app/kernel.ts), so two of
// them overlap: a drag in the GUI and an agent tool call can both be claiming a name.
// `writeFile`'s claim is atomic and needs nothing from us, but a MOVE's cannot be — no
// POSIX rename is both atomic and no-replace (packages/fs/volume.ts) — so the two
// steps have to not interleave, and the cheap way to guarantee that is to stop making
// them concurrently. One chain: every claim sees the previous one's result. Writers in
// other processes are outside this, and that window is documented where the check is.
let tail: Promise<unknown> = Promise.resolve()
function serially<T>(task: () => Promise<T>): Promise<T> {
	const run = tail.then(task, task)
	tail = run.catch(() => {})
	return run
}

async function claimPath(wanted: string, create: (path: string) => Promise<void>): Promise<string> {
	for (let n = 1; ; n++) {
		const candidate = n === 1 ? wanted : numberedPath(wanted, n)
		try {
			await create(candidate)
			return candidate
		} catch (e) {
			// EEXIST: someone holds the name. EISDIR: a folder holds it. Anything else
			// (ENOSPC, a bad path) is a real failure and must not spin.
			if (!/^E(EXIST|ISDIR)/.test((e as Error).message)) throw e
		}
	}
}

// Reducer state holds only the app-session facts that survive reload and that
// the agent should read: which note is open, change counters for the open file
// and for the tree, and the last error. Body bytes and the note list are NOT
// here — both are re-read from disk on demand (DESIGN.md §3).
export type NotesState = {
	openPath: string | null
	// Optional: both counters were added after the first release, and persisted
	// state is loaded verbatim — every reader defaults them.
	revision?: number
	treeRevision?: number
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

// A path this app will act on: the CANONICAL spelling, or nothing. Not a blacklist of
// spellings we have been bitten by (`..` once, `//` and a trailing `/` the next time)
// — the rule is that the path we validate has to be the path the volume writes, and
// the only way to say that once is to demand the one spelling it would produce
// (`isCanonicalPath`). Anything else is refused rather than repaired, so a checked
// path and a written path can never diverge and two spellings of one location can
// never circulate.
//
// Two schemas, because two different things are being named. `pathSchema` names an
// ENTRY — a note or a folder — and so refuses the root (`namesEntry`); `dirSchema`
// names a PLACE to put something, where the root is the default and perfectly valid.
// One predicate each, so every procedure and edge inherits the right one.
const CANONICAL =
	'path must be canonical: absolute, no empty "//" segments, no trailing "/", no "." or ".."'
const pathSchema = v.pipe(
	v.string(),
	v.check(
		namesEntry,
		`${CANONICAL} — and it must name a note or folder, not the knowledge base root`
	)
)
const dirSchema = v.pipe(v.string(), v.check(isCanonicalPath, CANONICAL))

// …and a third, for the actions that act on a NOTE's body. `list` returns folders
// too and the agent can hand one straight back: `open('/Trips')` used to leave the
// editor pointing at a directory whose read fails EISDIR, with nothing to show and
// nothing to fix it. Folder CRUD (`rename`, `remove`, `mkdir`) keeps `pathSchema`,
// because moving or deleting a folder is a real thing to want.
const noteSchema = v.pipe(
	v.string(),
	v.check(
		(path) => namesEntry(path) && isNotePath(path),
		`${CANONICAL} — and it must name a note (.md or .txt)`
	)
)

// `files[].path` inside an import is RELATIVE to `dir`, so it is judged as the thing
// it becomes — an entry under the knowledge base — by the same predicate. That is what
// refuses `''`: it joins to the root, which is not a note.
const memberSchema = v.pipe(
	v.string(),
	v.check(
		(path) => namesEntry(`/${path}`),
		'path must be a relative path naming a note, with no empty, "." or ".." segments'
	)
)

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
			v.object({ path: noteSchema }),
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
		//
		// `update: true` — a save EDITS a note, it never brings one into being. The path
		// here is always remembered from earlier (the GUI's open note, the agent's last
		// listing), and a plain write would recreate whatever has since been moved or
		// deleted, parent folders included: rename `/Trips` from Files while `Kyoto.md`
		// is open, and the next autosave would rebuild `/Trips` and leave a stale
		// duplicate in it. So the write is where the path is proven, and ENOENT is the
		// signal that the note moved (the GUI turns it into "…was moved or deleted", and
		// keeps the buffer). Creating is `create`'s job.
		save: t.on(
			v.object({ path: noteSchema, text: v.string() }),
			(state, { path, text }) => [
				state,
				t.cmd('volume', 'writeFile', path, enc.encode(text), { update: true }).to('saved')
			],
			{
				description:
					'Overwrite an EXISTING note’s body — fails if the note is gone (use `create` for a new one).',
				examples: [{ params: { path: '/Groceries.md', text: 'eggs, milk' } }]
			}
		),
		saved: t.fromResult('volume', 'writeFile', (state, r) =>
			r.ok ? { ...state, error: null } : { ...state, error: r.error.message }
		),

		// — rename IS move: one op covers retitling, dragging into a folder, and
		// renaming a folder. Internal (a `commit` edge): only the `rename` procedure
		// dispatches it, once the move has landed and its real destination is known.
		// `openPath` follows the moved file, or the moved folder it lives under.
		moved: t.commit(v.object({ from: pathSchema, to: pathSchema }), (state, { from, to }) => ({
			...state,
			openPath:
				state.openPath && isUnder(state.openPath, from)
					? `${to}${state.openPath.slice(from.length)}`
					: state.openPath,
			error: null
		})),

		// — external change to the OPEN file (the agent or Files edits it on disk) —
		fileChanged: t.fromEvent('volume', 'watch', (state) => ({
			...state,
			revision: (state.revision ?? 0) + 1
		})),
		// — something was created/removed/renamed somewhere in `/notes` —
		// `?? 0`: state persisted before these counters existed has neither field, and
		// `init` is NOT re-merged into stored state (docs/app.md §3), so `undefined + 1`
		// would freeze the counter at `NaN` and the tree would never refresh again.
		treeChanged: t.fromEvent('volume', 'watch', (state) => ({
			...state,
			treeRevision: (state.treeRevision ?? 0) + 1
		}))
	}),

	procedures: (p) => ({
		// The index — scanned fresh, RETURNED to the caller, never cached. One
		// recursive `scan` (the host walks the volume in a single round trip and
		// hands back mtimes), so nesting costs nothing extra.
		//
		// "Newest first" is true OF THE SCAN, and the GUI re-lists on every signal it can
		// get: a structural change anywhere, a write to the open note, and whenever a
		// surface that shows the list appears. What it cannot get is a content write to a
		// note that is NOT open — the storage's change feed carries a path only for
		// dirent mutations (packages/fs/storage.ts), so a recursive CONTENT watch could
		// not be scoped to `/notes` and would wake this app on every write anywhere in
		// the storage. Re-list rather than assume an old listing is still ordered.
		list: p.procedure({
			description:
				'List the knowledge base: every note (newest first as of this call) plus every folder, with path, title and mtime.',
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
			schema: v.object({ text: v.string(), dir: v.optional(dirSchema) }),
			async run({ text, dir }, app) {
				const wanted = joinPath(dir ?? '/', `${sanitizeName(firstLine(text))}${NOTE_EXT}`)
				const path = await claimPath(wanted, (probe) =>
					app.invoke('volume', 'writeFile', probe, enc.encode(text), { exclusive: true })
				)
				const { seq } = await app.dispatch({ type: 'open', params: { path } })
				return app.settled(seq)
			}
		}),

		// Rename IS move — retitle, drag into a folder, move a whole folder. It never
		// overwrites: `volume.rename(..., { exclusive: true })` refuses a destination
		// that is taken, and `claimPath` numbers up — the same loop `create` and
		// `importNotes` use, so the policy is one function, not three.
		//
		// That refusal is a check and then a move, not one operation, because no POSIX
		// rename is both atomic and no-replace. It holds for sequential writers, which
		// is every writer in this system: the import loop, an agent tool call, and a
		// multi-item drop that the tree applies one at a time (`persistDrop`). We do NOT
		// emulate the missing primitive — the placeholder version of this code was
		// wrong twice over (a claim is not a reservation in a shared store, and a file
		// placeholder is the wrong type to rename a folder over), and a `link`+`unlink`
		// version in the backend stopped being a move at all.
		rename: p.procedure({
			description:
				'Rename or move a note or folder, e.g. from "/Groceries.md" to "/Lists/Shopping list.md". `to` is the full destination path, so this also moves an item into another folder. An occupied destination is never overwritten — the moved item is numbered instead — and the resulting path is returned. Moving a folder inside itself is refused.',
			schema: v.object({ from: pathSchema, to: pathSchema }),
			async run({ from, to }, app) {
				if (to === from) return { path: from }
				// One guard for every caller — GUI, tree drag/drop and agent alike. See
				// `illegalMove`: `volume.rename` is a POSIX primitive and will cheerfully
				// strand a folder inside itself.
				const illegal = illegalMove(from, to)
				if (illegal) throw new Error(illegal)
				const path = await serially(() =>
					claimPath(to, (probe) => app.invoke('volume', 'rename', from, probe, { exclusive: true }))
				)
				const { seq } = await app.dispatch({ type: 'moved', params: { from, to: path } })
				await app.settled(seq)
				return { path }
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

		// Write a batch of imported notes (DESIGN.md §9). The GUI unzips, plans and
		// chunks; this is the write half. Paths are relative to `dir` (the knowledge
		// base root by default), so an imported vault MERGES into the existing tree
		// rather than hiding inside a wrapper folder. Nothing is ever overwritten: a
		// note whose path is taken lands beside it as `… 2`, and that count comes back
		// so the GUI can report it.
		importNotes: p.procedure({
			description:
				'Write a batch of notes, merging into the knowledge base — the import path for an Obsidian vault. `files[].path` is relative to `dir` (default "/"); folders are created as needed and an existing note is never overwritten (the incoming one is numbered instead). Returns how many were written, numbered, and could not be written — one bad name does not abandon the batch.',
			schema: v.object({
				dir: v.optional(dirSchema),
				files: v.array(v.object({ path: memberSchema, text: v.string() }))
			}),
			async run({ dir, files }, app) {
				let written = 0
				let renamed = 0
				let failed = 0
				for (const file of files) {
					// Imported names are written VERBATIM — never sanitized (DESIGN.md §4):
					// wikilinks address notes by their exact filename. `writeFile` creates
					// the parent folders.
					const wanted = joinPath(dir ?? '/', file.path)
					try {
						const path = await claimPath(wanted, (probe) =>
							app.invoke('volume', 'writeFile', probe, enc.encode(file.text), { exclusive: true })
						)
						if (path !== wanted) renamed++
						written++
					} catch {
						// A write already landed for every file before this one, so throwing
						// would report a batch of 50 as a total failure and lose the count.
						// Counted instead: the caller reports progress and what was missed.
						failed++
					}
				}
				return { written, renamed, failed }
			}
		}),

		readNote: p.procedure({
			description: 'Read a note’s body as text, e.g. path "/Remember the milk.md".',
			schema: v.object({ path: noteSchema }),
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
