import { defineApp } from '@justfiles/app'
import { volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'
import {
	illegalMove,
	isCanonicalPath,
	isDateStamp,
	isNotePath,
	isUnder,
	joinPath,
	journalPath,
	NOTE_EXT,
	namesEntry,
	noteTitle,
	numberedPath,
	renameTarget,
	SCRATCH_FILE,
	sanitizeName
} from './notes.ts'

// Notes live in the shared, top-level `/notes` knowledge base (DESIGN.md §1–2).
// A `/notes` prefix scope chroots the app there — its `/` IS `/notes` — while
// still hard-blocking `/system`. So every path in this file is plain
// root-relative: `/Remember the milk.md` lands at `/notes/Remember the milk.md`.
const enc = new TextEncoder()
const dec = new TextDecoder()

// Claim a free path — `Kyoto.md`, `Kyoto 2.md`, … keeping the extension. Try the name, and
// on EEXIST number up. Used by create, move and import: the single reason nothing in
// `/notes` is ever silently overwritten (DESIGN.md §3).
//
// For a CREATE the claim IS the check: `writeFile(..., { exclusive: true })` is `O_EXCL` in
// every backend, so a create cannot lose the name it took. For a MOVE there is no such
// primitive — POSIX `rename` replaces, and no no-replace form is reachable from Node — so
// the check is ours, made here, and `packages/fs` deliberately offers no flag for it (see
// volume.ts): a promise whose strength differed per backend is not one a call site can
// reason about. Hence the probe in the move's claim below, in ONE place rather than at each
// call site.
//
// That is what every system in this position does: git takes a lock it owns (`index.lock`,
// `O_CREAT|O_EXCL`), Maildir gives files names that cannot collide, dpkg moves a
// `.dpkg-tmp` into place. Ours is this chain plus that probe — and the chain is what makes
// the probe truthful.
//
// Procedures run OFF the kernel's per-app queue (packages/app/kernel.ts), so two of them
// overlap: a drag in the GUI and an agent tool call can both be taking a name. Mixing the
// two ways of taking one is the dangerous case — a move sees a free destination, an import
// claims it exclusively, and the move's rename then replaces the note that just landed
// while both callers report success. So the chain sits INSIDE `claimPath`, not at one call
// site: taking a name is a single serialized act however it is done, which is the only
// version of this that stays true when a fourth caller appears.
//
// Writers in OTHER processes sit outside it, exactly as they sit outside git's lock: a
// second app instance or a sync client reaching for the same new name in the same instant
// can still replace it. A knowingly accepted window, stated where the check is.
//
// One level, and only one: a caller that wraps a `claimPath` in `serially` deadlocks
// itself — it holds the chain while waiting for the chain. That is the price of a
// mutex, and the reason there is exactly one chain.
//
// EVERY write this app makes into the knowledge base rides it — the claims below, `save`,
// and `journal`'s append — because one of them is a read-modify-write and therefore cannot
// be interleaved with the others. `appendFile` is `getBlob` + concat + `putBlob`
// (packages/fs/volume.ts), so with a `save` running inside it: the append reads the old
// body, the save writes the edited one, and the append's write lands last — the user's
// typing is gone from disk while their buffer is CLEAN (its save succeeded), so nothing ever
// retries it. Silent and unrecoverable, which is the worst shape a loss can have.
//
// Ordered, that interleaving cannot exist: save-then-append keeps both, append-then-save
// keeps the typing and loses only the entry. What ordering does NOT do is make an append
// survive a full-body `save` that was composed before it — the buffer's text never contained
// the entry, so writing it erases it. That is the ordinary two-writers-one-note case
// (DESIGN.md §8), whose real answer is a precondition on `save` rather than a lock.
//
// A path-conditional version of this ("serialize saves to journal paths") was the obvious
// smaller fix and is the wrong shape: the journal note is not special as a FILE, it is
// special because we do a read-modify-write on it — so the rule belongs to the operation,
// not to a spelling, or it is one more thing to remember at the next call site.
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
			await serially(() => create(candidate))
			return candidate
		} catch (e) {
			// EEXIST: someone holds the name. EISDIR: a folder holds it. Anything else
			// (ENOSPC, a bad path) is a real failure and must not spin.
			if (!/^E(EXIST|ISDIR)/.test((e as Error).message)) throw e
		}
	}
}

// Is this path a FOLDER? Asked by doing something only a folder can do, rather than by
// reading a type constant across the capability seam: `scan` of a file is ENOTDIR. A
// spelling cannot answer it — `Archive.md` is a legal folder name — and the two callers
// that care (`rename`, `mkdir`) both used to be wrong about it.
async function isFolder(
	app: { invoke: (cap: 'volume', method: 'scan', input: { path: string }) => Promise<unknown> },
	path: string
): Promise<boolean> {
	try {
		await app.invoke('volume', 'scan', { path })
		return true
	} catch (thrown) {
		if (/^ENOTDIR/.test((thrown as Error).message)) return false
		throw thrown
	}
}

const MOVE_TRAIL = 8

// Reducer state holds only the app-session facts that survive reload and that
// the agent should read: which note is open, and change counters for the open file
// and for the tree. Body bytes and the note list are NOT here — both are re-read from
// disk on demand (DESIGN.md §3). Nor is "the last error": a write that fails has to be
// answered by whoever asked for it, while it is still holding the buffer that failed
// to land — so `save` is a procedure that throws, not an edge that files a complaint
// in state for someone to notice later.
export type NotesState = {
	// `null` = the SCRATCH buffer is showing (DESIGN.md §6) — the app's one unfiled
	// surface, not “nothing”. So this still answers “what is the user looking at”: a note,
	// or the scratch.
	openPath: string | null
	// Where the open note HAS BEEN, oldest first, so a client holding any of those
	// addresses can follow it forward. `openPath` alone cannot say WHY it changed — "the
	// agent renamed this" and "the agent opened something else" are the same change to it,
	// and they call for opposite handling (carry the buffer, or settle it where it is).
	//
	// A trail rather than a single previous address, because a client sees STATE, not each
	// transition: of two renames it may have followed the first and missed the second, or
	// missed both, and the answer has to fit either. Only moves that carried THIS note are
	// recorded — an unrelated rename must not answer the question. Cleared as soon as
	// something else moves the selection.
	movedFrom?: string[]
	// Optional: both counters were added after the first release, and persisted
	// state is loaded verbatim — every reader defaults them.
	revision?: number
	treeRevision?: number
}

// The shape `list` returns (never folded into state). Folders are included so
// the tree can show empty ones and CRUD has something to act on.
export type Entry = { path: string; type: 'file' | 'dir'; title: string; mtime: number }

export const initialState: NotesState = {
	openPath: null,
	revision: 0,
	treeRevision: 0
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
		(path) => namesEntry(`/${path}`) && isNotePath(path),
		'path must be a relative path naming a note (.md or .txt), with no empty, "." or ".." segments'
	)
)

export const app = defineApp({
	init: initialState,
	// TWO bindings of the same capability, because the app writes in two places with
	// different owners. Capabilities are declared under a LOCAL NAME which the kernel maps
	// to a trusted `{ id, scopes }` (packages/app/kernel.capability.ts), so a second name is
	// all a second scope takes — no change to the volume capability itself.
	//
	//   volume  → the shared knowledge base, chrooted at `/notes` (DESIGN.md §2)
	//   private → this app's own `/data/<id>`, where the scratch lives (`SCRATCH_FILE`)
	capabilities: {
		volume: volume({ scopes: ['/notes'] }),
		private: volume({ scopes: ['app'] })
	},

	// Two watches, two signals (DESIGN.md §3): the open file keeps its body live
	// when the agent or Files edits it on disk, and a recursive watch is the
	// structural signal — a create/remove/rename anywhere means the tree the user
	// is looking at is stale. Neither carries data; `list`/`readNote` re-read.
	// Because the structural signal carries nothing, it is `.coalesce()`d: an
	// unreduced wake is fully superseded by a newer one. `treeChanged` COMMITS (it
	// bumps `treeRevision`), so without that an import or a folder delete wrote
	// /state/notes.json once per file and queued a dispatch per file ahead of
	// everything else on this app's queue — including the host's GUI boot.
	subscriptions: (state, sub) => [
		sub.capability('volume', 'watch', { path: '/', recursive: true }).coalesce().to('treeChanged'),
		...(state.openPath
			? [sub.capability('volume', 'watch', { path: state.openPath }).to('fileChanged')]
			: [])
	],

	update: (t) => ({
		// — pure mutations (agent-visible) —
		open: t.on(
			v.object({ path: noteSchema }),
			(state, { path }) => ({ ...state, openPath: path, movedFrom: undefined }),
			{
				description: 'Open a note in the editor — surfaces it in the user’s window.',
				examples: [{ params: { path: '/Remember the milk.md' } }]
			}
		),
		newNote: t.on(v.object({}), (state) => ({ ...state, openPath: null, movedFrom: undefined }), {
			description:
				'Close the open note and show the scratch buffer — the unfiled surface the app opens on.'
		}),

		// Internal, like `moved`: the `remove` procedure reports WHAT WAS DELETED and the
		// reducer decides what that means for the selection. It cannot decide that itself —
		// `app.state` inside a procedure is the snapshot from when it started, so a selection
		// another client changed while `rm` was in flight would be cleared for no reason, and
		// a note opened UNDER the deleted folder in that window would stay selected. The
		// containment question has one right place to be asked: where the current state is.
		deleted: t.commit(v.object({ path: pathSchema }), (state, { path }) =>
			state.openPath !== null && isUnder(state.openPath, path)
				? { ...state, openPath: null, movedFrom: undefined }
				: state
		),

		// — rename IS move: one op covers retitling, dragging into a folder, and
		// renaming a folder. Internal (a `commit` edge): only the `rename` procedure
		// dispatches it, once the move has landed and its real destination is known.
		// `openPath` follows the moved file, or the moved folder it lives under.
		moved: t.commit(v.object({ from: pathSchema, to: pathSchema }), (state, { from, to }) => {
			const open = state.openPath
			if (open === null || !isUnder(open, from)) return state // a move of something else
			return {
				...state,
				openPath: `${to}${open.slice(from.length)}`,
				// A trail, not a log: enough to bridge the renames a client can miss between two
				// views of state, bounded so a script renaming in a loop cannot grow it.
				movedFrom: [...(state.movedFrom ?? []), open].slice(-MOVE_TRAIL)
			}
		}),

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

		// Create a note. The NAME is given, never derived from the body (DESIGN.md §4): a note
		// is named before it exists, by the person or agent that wanted it, and the body is
		// whatever it starts with — usually nothing. `dir` defaults to the vault root; the GUI
		// passes the open note's folder so new notes land beside their sibling.
		create: p.procedure({
			description:
				'Create a note called `title`, e.g. title "Remember the milk" → /Remember the milk.md. `text` is the body (empty by default — the title is NOT repeated in it). Pass `dir` to create it inside a folder.',
			schema: v.object({
				title: v.string(),
				text: v.optional(v.string()),
				dir: v.optional(dirSchema)
			}),
			async run({ title, text = '', dir }, app) {
				const wanted = joinPath(dir ?? '/', `${sanitizeName(title)}${NOTE_EXT}`)
				// `parents: false`: the folder has to be there ALREADY. The GUI decides where a
				// new note goes from its listing, which is a snapshot — a folder the agent
				// deleted a moment ago still looks live in it — and the host would otherwise
				// rebuild the folder around the note. The write is the only check with no gap.
				const path = await claimPath(wanted, (probe) =>
					app.invoke('volume', 'writeFile', probe, enc.encode(text), {
						exclusive: true,
						parents: false
					})
				)
				const { seq } = await app.dispatch({ type: 'open', params: { path } })
				// `settled` is asked for ORDERING — that the selection is visible before the
				// caller acts on it — never for the answer. It resolves with the state after the
				// queue drains, which may carry another client's `open`; returning that would
				// hand the caller someone else's note as the identity of the bytes it just wrote,
				// and the next save would land there. The path we claimed is a local fact.
				await app.settled(seq)
				return { path }
			}
		}),

		// Rename IS move — retitle, drag into a folder, move a whole folder. It never
		// overwrites, and here that is OUR check rather than the volume's: POSIX `rename`
		// replaces, so `claimPath` probes the destination and numbers up on EEXIST — the same
		// loop `create` and `importNotes` use, ordered on the same chain, so the policy is one
		// function and not three.
		//
		// The probe and the move are two steps, which is why the chain matters and why the
		// window that remains is another PROCESS (see `claimPath`). We do not push this down
		// into the filesystem: the placeholder version was wrong twice over (a claim is not a
		// reservation in a shared store, and a file placeholder is the wrong type to rename a
		// folder over), a `link`+`unlink` version stopped being a move, and an in-process lock
		// under the backend cannot see the processes that actually share the directory.
		rename: p.procedure({
			description:
				'Rename or move a note or folder, e.g. from "/Groceries.md" to "/Lists/Shopping list.md". `to` is the full destination path, so this also moves an item into another folder. An occupied destination is never overwritten — the moved item is numbered instead — and the resulting path is returned. Moving a folder inside itself is refused.',
			schema: v.object({ from: pathSchema, to: pathSchema }),
			async run({ from, to }, app) {
				// A note that stops being `.md`/`.txt` stops being a note: `list` hides it and
				// `readNote`/`save` refuse it, so "rename Groceries.md to Shopping" would leave
				// the user's note invisible and unsavable. The source's extension is carried
				// over when the destination has none — here, not in the GUI, so the agent and
				// the tree get the same answer.
				const target = renameTarget(from, to, !(await isFolder(app, from)))
				if (target === from) return { path: from }
				// One guard for every caller — GUI, tree drag/drop and agent alike. See
				// `illegalMove`: `volume.rename` is a POSIX primitive and will cheerfully
				// strand a folder inside itself.
				const illegal = illegalMove(from, target)
				if (illegal) throw new Error(illegal)
				const path = await claimPath(target, async (probe) => {
					// The check POSIX `rename` will not make for us. Inside `claimPath`'s chain, so
					// no other claim of this app's can land between it and the move.
					if (await app.invoke('volume', 'exists', probe)) throw new Error(`EEXIST: ${probe}`)
					await app.invoke('volume', 'rename', from, probe)
				})
				const { seq } = await app.dispatch({ type: 'moved', params: { from, to: path } })
				await app.settled(seq)
				return { path }
			}
		}),

		// Folders are ordinary directories; `writeFile` auto-creates parents, so
		// this exists only to make an EMPTY folder.
		// Asking for a folder where a note already sits is EEXIST — from `mkdir` itself, not
		// from a check here. A check here could be overtaken by the import writing that same
		// name, and `mkdir -p` would then walk past the file and report success.
		mkdir: p.procedure({
			description: 'Create a folder, e.g. "/Trips".',
			schema: v.object({ path: pathSchema }),
			async run({ path }, app) {
				await app.invoke('volume', 'mkdir', path, { recursive: true })
			}
		}),

		// Write a batch of imported notes (DESIGN.md §10). The GUI unzips, plans and
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

		// The scratch buffer's two halves. It is a file like any other — the GUI drives it with
		// the SAME buffer machine it drives a note with (`src/buffer.ts`, one machine, two
		// instances) — it just lives in this app's own volume rather than in the knowledge base.
		//
		// Readable by the agent (“what's in my scratch?” is a fair question), writable only by
		// the GUI: an agent that could overwrite the whole buffer could erase words the user has
		// not filed yet, and `journal`/`create` are the ways to move them somewhere permanent.
		readScratch: p.procedure({
			description:
				'Read the scratch buffer — the unfiled text the user dumps into the editor when no note is open. Empty when it has never been used.',
			schema: v.object({}),
			async run(_params, app) {
				try {
					return { text: dec.decode(await app.invoke('private', 'readFile', SCRATCH_FILE)) }
				} catch (thrown) {
					// Never written = empty, not broken. Every other failure is real and thrown, so a
					// buffer that could not be READ is never silently replaced by a blank one that the
					// next keystroke would save over it.
					if (/^ENOENT/.test((thrown as Error).message)) return { text: '' }
					throw thrown
				}
			}
		}),

		// Overwrite the scratch. No `update: true` and no `exclusive` — unlike a note (see
		// `save`), re-creating this file is CORRECT: the scratch is a place, not a thing
		// someone named, so “it is not there yet” is its ordinary first state and “someone
		// deleted it” is not a fact worth preserving.
		saveScratch: p.procedure({
			description: 'Overwrite the scratch buffer.',
			audience: 'gui',
			schema: v.object({ text: v.string() }),
			async run({ text }, app) {
				await app.invoke('private', 'writeFile', SCRATCH_FILE, enc.encode(text))
			}
		}),

		// Keep something without naming it: append to the day's journal note. The other half
		// of what the scratch needs — `create` files words under a name the user chose, this
		// files them under the one name nobody has to choose (DESIGN.md §6).
		//
		// `date` is the CALLER's, because only the caller has the user's clock: a procedure
		// runs in the worker, where `new Date()` is UTC and would file an evening entry under
		// tomorrow.
		journal: p.procedure({
			description:
				'Append text to the day’s journal note (/journal/<date>.md), creating it if needed. `date` is that day as YYYY-MM-DD, in the user’s own timezone. The text is appended as given, so include a heading if you want one.',
			schema: v.object({
				date: v.pipe(v.string(), v.check(isDateStamp, 'date must be YYYY-MM-DD')),
				text: v.string()
			}),
			async run({ date, text }, app) {
				const path = journalPath(date)
				// ON THE CHAIN, because an append is not atomic and this one accumulates. `appendFile`
				// is read-merge-write in the volume (`getBlob`, concat, `putBlob` — packages/fs/volume.ts),
				// so two that overlap both read the same body and the later write drops the earlier
				// entry — and a `save` landing inside one does the same to the user's typing.
				// `exclusive: true` below only protects the FIRST entry of the day.
				//
				// And overlapping is IN this app's model, not a hypothetical: procedures run off the
				// kernel's queue, `journal` is `both`, so the agent filing something while the user
				// keeps a scratch entry is the interleaving DESIGN.md §8 defends. Losing an append is
				// also a worse failure than losing a keystroke — it is words someone asked to KEEP.
				//
				// Not pushed down into `packages/fs`: an atomic append means something different on
				// every backend (O_APPEND here, a transaction there), and §1b is the record of what a
				// per-backend promise costs a call site. Ordering our own writes is cheap; the window
				// that remains is another PROCESS, exactly as it is for `claimPath`.
				return serially(async () => {
					try {
						// The first entry of the day CREATES the note, exclusively: two windows keeping
						// something in the same instant would otherwise both create it and one would
						// overwrite the other. EEXIST is then the ordinary case — append. (EISDIR is not:
						// a folder holding that name is a real problem, so it is thrown.)
						await app.invoke('volume', 'writeFile', path, enc.encode(text), { exclusive: true })
					} catch (thrown) {
						if (!/^EEXIST/.test((thrown as Error).message)) throw thrown
						await app.invoke('volume', 'appendFile', path, enc.encode(`\n\n${text}`))
					}
					return { path }
				})
			}
		}),

		// Persist a note's body. A PROCEDURE, not an edge, because the caller has to know
		// whether the bytes landed while it still holds them: the GUI flushes before it
		// opens another note, starts a new one, or moves this one, and a fire-and-forget
		// write would report its failure after that transition — against a different
		// `openPath`, with the text it failed to save already gone from the buffer.
		//
		// `update: true` — a save EDITS a note, it never brings one into being. The path
		// is always remembered from earlier (the GUI's open note, the agent's last
		// listing), and a plain write would recreate whatever has since been moved or
		// deleted, parent folders included: rename `/Trips` from Files while `Kyoto.md` is
		// open, and the next autosave would rebuild `/Trips` and leave a stale duplicate
		// in it. So the write is where the path is proven, and ENOENT is the signal that
		// the note is gone — which the GUI answers by keeping the buffer and detaching it
		// (see `gui.tsx`). Creating is `create`'s job.
		save: p.procedure({
			description:
				'Overwrite an EXISTING note’s body — fails if the note is gone (use `create` for a new one).',
			schema: v.object({ path: noteSchema, text: v.string() }),
			async run({ path, text }, app) {
				// On the chain with every other write into the KB (see `serially`): a body write that
				// lands INSIDE `journal`'s read-modify-write is the one interleaving that loses the
				// user's typing with no copy left anywhere.
				await serially(() =>
					app.invoke('volume', 'writeFile', path, enc.encode(text), { update: true })
				)
				return { path }
			}
		}),

		// No `exists` probe, no type check: the READ is the check, and its errors are
		// exactly the two questions worth asking. `noteSchema` can only judge the spelling,
		// and a folder called `Archive.md` passes every lexical test there is — `readFile`
		// says EISDIR. A note that was moved or deleted says ENOENT. Neither could be
		// established before the read anyway, and answering "not there" with an empty string
		// hands the editor a blank buffer to save over whatever the path has become. So it
		// throws, and a path we cannot read is not one to stay pointed at: the GUI answers
		// both the same way, by detaching (see `gui.tsx`).
		readNote: p.procedure({
			description: 'Read a note’s body as text, e.g. path "/Remember the milk.md".',
			schema: v.object({ path: noteSchema }),
			async run({ path }, app) {
				return { path, text: dec.decode(await app.invoke('volume', 'readFile', path)) }
			}
		}),

		// Destructive — gui-only. `/notes` is the user's; the agent never deletes
		// user notes blindly (mirrors app-code's gui-only `remove`). DESIGN.md §7.
		remove: p.procedure({
			description: 'Delete a note, or a folder and everything in it.',
			audience: 'gui',
			schema: v.object({ path: pathSchema }),
			async run({ path }, app) {
				await app.invoke('volume', 'rm', path, { force: true, recursive: true })
				const { seq } = await app.dispatch({ type: 'deleted', params: { path } })
				await app.settled(seq)
			}
		})
	})
})

export type NotesApp = typeof app
