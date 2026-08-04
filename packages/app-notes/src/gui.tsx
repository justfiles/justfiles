import type { GUIProps } from '@justfiles/app/react'
import type { AsyncFlateStreamHandler, UnzipDecoder, UnzipDecoderConstructor } from 'fflate'
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Entry, NotesApp } from './app.ts'
import type { Buffer, BufferIO, BufferState, Unsettled } from './buffer.ts'
import { createBuffer } from './buffer.ts'
import {
	admit,
	createScreen,
	type ImportEntry,
	type ImportPlan,
	MAX_BYTES,
	planImport,
	type Screen,
	screenEntry,
	zipEntryName
} from './import.ts'
import { MoveNoteControl } from './move-picker.tsx'
import {
	cutKept,
	displayPath,
	draftSurvives,
	failedWith,
	illegalName,
	isUnder,
	joinPath,
	localDateStamp,
	localTimeStamp,
	matchNotes,
	NOTE_EXT,
	noteTitle,
	parentDir,
	renameTarget,
	SCRATCH_FILE,
	sanitizeName,
	splitSelection
} from './notes.ts'
import { NotesTree } from './tree.tsx'
import './style.css'

const AUTOSAVE_MS = 800
// A bulk writer bumps `treeRevision` per file; wait for the burst to end before
// re-scanning. Short enough that a single agent write still feels immediate.
const REFRESH_MS = 250
// One import call per batch of notes: big enough to keep the round trips down,
// small enough that the status line moves and one message stays modest.
// How a buffer that would not land is explained. The machine decides WHAT happened
// (`buffer.ts`); this is the only place that decides how to say it.
// The folder a note was aimed at is not there — as opposed to being unwritable for the
// moment. ENOTDIR: something that is not a folder holds the name.
const missingFolder = (failure: unknown) => failedWith(failure, 'ENOENT', 'ENOTDIR')

const explain = (outcome: Unsettled) =>
	outcome.because === 'gone'
		? 'The note you were editing was moved or deleted — your changes are kept here'
		: `Could not save ${outcome.path ? displayPath(outcome.path) : 'this note'} — ${outcome.error.message}`

// The scratch's own wording. Its failures are a shorter list than a note's — it cannot be
// renamed or deleted, so "gone" is not a thing that happens to it (and if the volume ever
// says so, the next write re-creates it: see `scratchIO.create`).
const explainScratch = (outcome: Unsettled) =>
	`Could not save the scratch — ${outcome.error.message}`

// Said when the kept words could not be taken out of the scratch, because they were edited
// while the write was in flight (see `promoteScratch`). The user has them twice, which is
// recoverable — and being told is what makes it so.
const COPY_STAYED = '— the scratch changed while it saved, so a copy is still in it'

const IMPORT_CHUNK = 50
// How much of an archive is handed to the unzipper at once (see `readZip`).
const PUSH_SLICE = 65_536
const STATUS_MS = 8000
const LIST_PREF_KEY = 'app-notes:list-open'
const WIDTH_PREF_KEY = 'app-notes:list-width'
const WIDTH_DEFAULT = 220
const WIDTH_MIN = 150
const WIDTH_MAX = 480

const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform)

// The host may sandbox the app iframe without `allow-same-origin`, where even
// touching localStorage throws — degrade to a per-session preference.
const readPref = (key: string) => {
	try {
		return localStorage.getItem(key)
	} catch {
		return null
	}
}
const writePref = (key: string, value: string) => {
	try {
		localStorage.setItem(key, value)
	} catch {
		// sandboxed — the control still works, it just resets next launch
	}
}
const readListPref = () => readPref(LIST_PREF_KEY) === '1'
const readWidthPref = () => clampWidth(Number(readPref(WIDTH_PREF_KEY)) || WIDTH_DEFAULT)

function clampWidth(px: number): number {
	return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(px)))
}

// Read the archive as a STREAM. Two reasons, both about memory the tab does not
// have: an entry we don't want is judged from its header and never inflated, and
// the archive itself is never held — `arrayBuffer()` on a 2 GB vault of photos
// would kill the tab before a single limit was consulted. That vault now costs us
// the few MB of notes inside it.
async function readZip(file: File, screen: Screen): Promise<ImportEntry[]> {
	const kept: ImportEntry[] = []
	let failure: Error | null = null

	// The per-entry cap has to live in the DECODER, because an entry cannot be
	// aborted from outside: `UnzipInflate` has no `terminate`, and the stream keeps
	// feeding whichever decoder is active. Enforced downstream of the header, so a
	// bomb that declares nothing (or lies) is inflated only up to the cap — past it
	// this stops pushing, and the compressed remainder is walked, not expanded.
	const bounded = (Inner: UnzipDecoderConstructor): UnzipDecoderConstructor =>
		class Bounded implements UnzipDecoder {
			static compression = Inner.compression
			ondata!: AsyncFlateStreamHandler
			private readonly inner: UnzipDecoder
			private out = 0
			private dead = false
			constructor(name: string, size?: number, originalSize?: number) {
				this.inner = new Inner(name, size, originalSize)
				this.inner.ondata = (error, chunk, final) => {
					if (this.dead) return
					this.out += chunk.length
					if (this.out > MAX_BYTES) {
						// Never completed, so the entry is never admitted; reported here
						// because this is the only place that knows it outgrew its header.
						this.dead = true
						screen.skip(zipEntryName(name), 'attachment')
						return
					}
					this.ondata(error, chunk, final)
				}
			}
			push(chunk: Uint8Array, final: boolean) {
				if (!this.dead) this.inner.push(chunk, final)
			}
		}

	const unzipper = new Unzip((entry) => {
		// The archive's own spelling of the name, which it may have got wrong — every use
		// of it downstream goes through this, and fflate's raw `entry.name` through none.
		const name = zipEntryName(entry.name)
		// Not content, but still a member: it counts as work, or an archive of nothing
		// but directories never reaches the ceiling meant to stop it.
		if (name.endsWith('/')) {
			screen.ignore(name)
			return
		}
		// A cheap pre-check, from the local header: skip what we can already tell we
		// don't want, so it is never inflated. The header's size is a CLAIM though —
		// a streamed archive may declare 0 — so nothing is charged to the budget here.
		const declared = screenEntry(name, entry.originalSize ?? 0)
		if (declared) {
			screen.skip(name, declared)
			return
		}
		let parts: Uint8Array[] = []
		let size = 0
		entry.ondata = (error, chunk, final) => {
			if (error) {
				failure ??= error
				return
			}
			size += chunk.length
			parts.push(chunk)
			// Charged with the bytes that actually exist, at the moment they exist. An
			// entry the decoder gave up on never reaches `final`, so it never lands here.
			if (final) {
				const entered = admit({ path: name, bytes: concat(parts, size) }, screen)
				parts = []
				if (entered) kept.push(entered)
			}
		}
		entry.start()
	})
	unzipper.register(bounded(UnzipInflate))
	unzipper.register(bounded(UnzipPassThrough))
	const reader = file.stream().getReader()
	for (;;) {
		const { done, value } = await reader.read()
		if (done) {
			unzipper.push(new Uint8Array(0), true)
			break
		}
		// Handed over in SLICES, not whole. fflate's `Unzip.push` recurses once per
		// entry header it finds in the buffer it is given, so one chunk carrying tens of
		// thousands of tiny entries overflows the stack — before a single one of our
		// budgets is consulted. Slicing bounds the recursion by the slice, not by the
		// archive; the parser keeps its own leftovers across calls.
		for (let at = 0; at < value.length; at += PUSH_SLICE) {
			unzipper.push(value.subarray(at, at + PUSH_SLICE))
			if (failure || screen.stopped) break
		}
		if (failure) break
		// The budget is spent, so every later entry would be refused anyway — stop
		// reading rather than streaming the remaining gigabytes in order to reject them.
		if (screen.stopped) {
			await reader.cancel()
			break
		}
	}
	if (failure) throw failure
	return kept
}

function concat(parts: readonly Uint8Array[], size: number): Uint8Array {
	if (parts.length === 1) return parts[0] as Uint8Array
	const out = new Uint8Array(size)
	let at = 0
	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}
	return out
}

const isZip = (file: File) => file.name.toLowerCase().endsWith('.zip')

// Dropped files → one plan. A zip is a vault export (its own folder name wins);
// loose files are imported under their own name. Both merge into the KB root.
async function planDrop(files: File[]): Promise<ImportPlan> {
	const screen = createScreen()
	const zips = files.filter(isZip)
	// An archive is a whole vault, and its root folder is stripped on the way in — a
	// rule that only makes sense for ONE archive. Rather than import the first and
	// quietly drop the rest of the drop, refuse the lot and say so.
	if (zips.length > 0 && files.length > 1) {
		throw new Error(
			`drop one archive on its own — that drop had ${zips.length} archive${zips.length === 1 ? '' : 's'} and ${files.length - zips.length} other file${files.length - zips.length === 1 ? '' : 's'}`
		)
	}
	const zip = zips[0]
	if (zip) return planImport(await readZip(zip, screen), zip.name, screen)
	// A LIST, not a map keyed by name: two files dropped from different folders share
	// a basename, and a map would keep only the last — reported as a clean success
	// while losing a note. Duplicates ride through and the write-side claim numbers
	// the second one.
	const entries: ImportEntry[] = []
	for (const file of files) {
		// The ledger is spent: stop READING, exactly as the archive stream is abandoned.
		// Judging each remaining file individually would still pull gigabytes into the tab
		// after the importer has already decided to keep none of it.
		if (screen.stopped) break
		// Screened from `File.size` FIRST: reading a 2 GB body into the tab only to
		// classify it as an attachment is the same mistake as inflating a zip entry.
		const reason = screenEntry(file.name, file.size)
		if (reason) {
			screen.skip(file.name, reason)
			continue
		}
		const entered = admit(
			{ path: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
			screen
		)
		if (entered) entries.push(entered)
	}
	return planImport(entries, 'Imported', screen)
}

function relativeTime(mtimeNs: number): string {
	const ms = mtimeNs / 1e6
	const diff = Date.now() - ms
	if (!Number.isFinite(diff)) return ''
	const mins = Math.round(diff / 60000)
	if (mins < 1) return 'now'
	if (mins < 60) return `${mins}m`
	const hours = Math.round(mins / 60)
	if (hours < 24) return `${hours}h`
	return `${Math.round(hours / 24)}d`
}

export default function Notes({ state, actions }: GUIProps<NotesApp>) {
	// Both counters are optional in persisted state (added after the first release,
	// and `init` is never re-merged) — default them at the door.
	const { openPath, revision = 0, treeRevision = 0, movedFrom } = state

	// The editor buffer is transient GUI-local state; the body bytes never enter the
	// reducer (DESIGN.md §3). It is a MACHINE, not a set of flags — `src/buffer.ts` owns
	// the rules ("nothing replaces an unsettled buffer", "a failed write stays unsaved",
	// "gone and busy call for opposite recoveries", "writes do not overlap", "a stale read
	// is discarded"), and this component only drives it and renders its state.
	const [buffer, setBuffer] = useState<BufferState>({ text: '', dirty: false, path: null })
	// The SCRATCH buffer (DESIGN.md §6): the same machine, a second instance. It holds the
	// words the user has not decided anything about, and it is what the editor shows whenever
	// no note is open — the app has no inert surface any more.
	const [scratch, setScratch] = useState<BufferState>({ text: '', dirty: false, path: null })
	// Its text comes from disk a round trip after mount, and the editor stays read-only until
	// it arrives: keystrokes typed over an unfinished read would be saved on top of the words
	// being read. `failed` is the same surface with a reason and a way back (window focus).
	const [scratchState, setScratchState] = useState<'loading' | 'ready' | 'failed'>('loading')

	// The bar's search field doubles as the palette (DESIGN.md §5): focusing it
	// drops the recency list down; typing filters; Enter opens-or-creates. The
	// docked list pane is the same list, pinned — a GUI-local preference.
	const [query, setQuery] = useState('')
	const [searchFocused, setSearchFocused] = useState(false)
	// The name field, while the user is editing it. `null` = not editing, so the field shows
	// the truth (the buffer's own path) and an agent rename appears in it with no bookkeeping.
	//
	// On the SCRATCH it is also what OPENS the save prompt: the scratch has no name line to
	// edit (§6), so a draft is the whole state of "the user is naming this" — `''` on the way
	// in, `null` again on cancel. No second flag to keep level with it, and every path that
	// already drops the draft (opening a note, creating one, going back to the scratch) closes
	// the prompt for free.
	const [titleDraft, setTitleDraft] = useState<string | null>(null)
	const [titleError, setTitleError] = useState<string | null>(null)
	const [dropOpen, setDropOpen] = useState(false)
	const [listOpen, setListOpen] = useState(readListPref)
	const [listWidth, setListWidth] = useState(readWidthPref)
	const [entries, setEntries] = useState<Entry[]>([])
	const [active, setActive] = useState(0)
	const [dragging, setDragging] = useState(false)
	// Import feedback (transient, GUI-local): "Importing… 120/400", then the report.
	const [status, setStatus] = useState<string | null>(null)
	const [fileDrop, setFileDrop] = useState(false)
	// The folder last clicked in the tree — a *hint*, not a maintained pointer. Where
	// a new note goes is decided at creation time (`createDir` below) and the hint is
	// dropped if that folder is no longer on disk, so deleting or moving a folder
	// needs no bookkeeping here.
	const selectedDirRef = useRef<string | null>(null)

	// `dir` is where a new note would go, recomputed every render (see `createDir`) and
	// read at write time — never remembered, because folders are deleted underneath it.
	const dirRef = useRef('/')
	const editorRef = useRef<HTMLTextAreaElement>(null)
	const searchRef = useRef<HTMLInputElement>(null)
	// Hung on whichever row the keyboard is on, and on no other: the highlight is the only thing
	// that says where Return will go, so arrowing past the bottom of the dropdown has to bring
	// the list with it. React hands the element to this the moment the selection lands on a row
	// (and hands the row it left a `null`), which is exactly when the scroll is owed — `nearest`
	// then scrolls only if the row is actually out of sight, so a visible selection never jumps.
	const activeRowRef = useCallback((el: HTMLElement | null) => {
		el?.scrollIntoView({ block: 'nearest' })
	}, [])
	// The input that NAMES things — the note's name field, or the scratch's save prompt. Only
	// ever one of them is mounted, which is what lets ⌘S say "put the user where the name is
	// asked for" without knowing which surface is up.
	const titleRef = useRef<HTMLInputElement>(null)
	// The draft, as a ref as well as state: Esc and Enter both blur the field, and a blur
	// handler reading React state would still see the draft they just abandoned and commit it.
	const draftRef = useRef<string | null>(null)
	// Which note the live draft was typed for — the buffer's address when the first keystroke
	// landed in the field. `null` is a real value here: a detached buffer still holds the words
	// the draft is about (see the effect below).
	const draftForRef = useRef<string | null>(null)
	const setDraft = useCallback((next: string | null) => {
		draftRef.current = next
		setTitleDraft(next)
	}, [])

	// The search field is the way in — ⌘O, ⌘N, Esc from the body, and every dead end (a
	// deleted note, a fresh launch) all land here, because naming is how a note begins.
	const focusSearch = useCallback(() => {
		searchRef.current?.focus()
		searchRef.current?.select()
	}, [])

	// Read through a ref, so the machine — built once — always calls the current actions.
	const actionsRef = useRef(actions)
	actionsRef.current = actions

	// Every create in the app goes through here. Aimed at `dir`, but only "that folder is not
	// there" is grounds for putting the note somewhere else: an EACCES or an EIO on the folder
	// is a passing problem with the RIGHT place, and relocating on it would file the note in
	// the wrong folder while blaming a deletion that never happened — so those are rethrown.
	const createIn = useCallback(async (title: string, text: string, dir: string) => {
		try {
			return (await actionsRef.current.create({ title, text, dir })).path
		} catch (failure) {
			if (dir === '/' || !missingFolder(failure)) throw failure
			setStatus('That folder is gone — saved at the top level instead')
			return (await actionsRef.current.create({ title, text, dir: '/' })).path
		}
	}, [])

	// The name the buffer's own create must use. It has exactly one caller — the note the
	// buffer was holding got deleted or moved out from under it, and the words typed since
	// have to land somewhere — so the right name is the one that note had. Nothing derives a
	// name from a body any more (DESIGN.md §4), which is why the name has to be remembered.
	const nameRef = useRef('Untitled')

	// The volume, as the three functions the buffer needs. Everything app-specific stays
	// out here: where a note lands, what it is called, and the fact that `save`/`readNote`
	// are procedures that throw.
	const io = useRef<BufferIO>({
		save: async (path, text) => {
			await actionsRef.current.save({ path, text })
		},
		create: (text) => createIn(nameRef.current, text, dirRef.current),
		read: async (path) => (await actionsRef.current.readNote({ path })).text
	})

	// One machine for the lifetime of the component. Its state is mirrored into React
	// state so the editor re-renders; the machine, not the component, is the truth.
	const bufferRef = useRef<Buffer | null>(null)
	if (bufferRef.current === null) bufferRef.current = createBuffer(io.current, setBuffer)
	const buf = bufferRef.current

	// The scratch as the SAME machine, a second instance (DESIGN.md §6). Every rule the
	// buffer keeps — writes never overlap, a failed write stays dirty, a stale read is
	// discarded, nothing replaces an unsettled buffer — is a rule the scratch needs too, and
	// threading a third kind of home through `buffer.ts` would have been a new mode in the one
	// place this app cannot afford one (DESIGN.md §1a‴). IO is injected, so a second instance
	// is all it takes.
	const scratchIO = useRef<BufferIO>({
		// The path is IGNORED: the scratch lives at `SCRATCH_FILE` in the app's own volume, and
		// the procedure knows where that is. So the machine's sentinel path can never leak into
		// the knowledge base.
		save: async (_path, text) => {
			await actionsRef.current.saveScratch({ text })
		},
		// "These words have no address" means the scratch IS their address — so this both writes
		// and re-attaches. Reached only if a write ever failed with a gone-class code; a note's
		// version of this creates a new note instead (see `io` above).
		create: async (text) => {
			await actionsRef.current.saveScratch({ text })
			return SCRATCH_FILE
		},
		read: async () => (await actionsRef.current.readScratch({})).text
	})
	const scratchBufRef = useRef<Buffer | null>(null)
	if (scratchBufRef.current === null)
		scratchBufRef.current = createBuffer(scratchIO.current, setScratch)
	const scratchBuf = scratchBufRef.current

	// `settle` returns whether the buffer is landed, and every caller that is about to
	// change what the editor shows has to obey it (DESIGN.md §1a‴). Reporting is the
	// GUI's half: the machine decides what happened, this decides how to say it.
	const settle = useCallback(async (): Promise<boolean> => {
		const outcome = await buf.settle()
		if (outcome.settled) return true
		setStatus(explain(outcome))
		return false
	}, [buf])

	// The scratch's half of the same rule. Called before anything that takes the editor away
	// from it, and by its own debounce.
	const settleScratch = useCallback(async (): Promise<boolean> => {
		const outcome = await scratchBuf.settle()
		if (outcome.settled) return true
		setStatus(explainScratch(outcome))
		return false
	}, [scratchBuf])

	// Read the scratch from disk — at mount, and again whenever the window comes back. ONE
	// function, because a read that fails means the same thing either way: we cannot prove the
	// buffer matches what is on disk, so the editor must not let it be typed over.
	//
	// That rule was first written for the mount read only, which left the more dangerous case
	// open: a scratch that loaded once, then failed a re-read after ANOTHER window wrote newer
	// text, kept a stale buffer editable — and the next autosave would put the stale text back
	// over the newer one. A read we did not get is not evidence that nothing changed.
	//
	// `open` versus `reload` is about what the buffer is holding, not about the failure: after a
	// mount that failed there is nothing attached, so `reload` (which only ever replaces a
	// CLEAN, attached buffer) would no-op forever.
	const loadScratch = useCallback(
		async (how: 'open' | 'reload') => {
			const outcome =
				how === 'open' ? await scratchBuf.open(SCRATCH_FILE) : await scratchBuf.reload(SCRATCH_FILE)
			if (outcome.opened) {
				setScratchState('ready')
				return
			}
			setScratchState('failed')
			setStatus(
				outcome.because === 'unsettled'
					? explainScratch(outcome.outcome)
					: `Could not read the scratch — ${outcome.error.message}. It stays read-only until that succeeds.`
			)
		},
		[scratchBuf]
	)

	useEffect(() => {
		void loadScratch('open')
	}, [loadScratch])

	// A second window — or the desktop app beside the browser — writes the same file, and
	// there is no watch on it: the scratch is app-private, so a capability stream just so one
	// client can hear another is more machinery than the case is worth. Re-read when the
	// window comes back instead. `reload` only ever replaces a CLEAN buffer, so it cannot land
	// on top of words that have not been saved yet — and a dirty buffer is newer than the disk
	// anyway, so it stays `ready` and keeps being editable.
	useEffect(() => {
		const onFocus = () => void loadScratch(scratchState === 'failed' ? 'open' : 'reload')
		window.addEventListener('focus', onFocus)
		return () => window.removeEventListener('focus', onFocus)
	}, [scratchState, loadScratch])

	// The buffer follows a note to a new address — its own rename, or a folder's — and so does
	// the name field's draft: same words, same draft, new place. ONE function because they are
	// one fact, and two call sites (the agent's rename, and ours) that must not drift: the
	// effect below reads `draftForRef` to decide whether a path change means "a different
	// note", and a stale target there would answer that question wrong.
	const followMove = useCallback(
		(from: string, to: string) => {
			buf.moved(from, to)
			draftForRef.current = buf.snapshot().path
		},
		[buf]
	)

	// Debounced autosave: `text` is the reset trigger — each keystroke restarts the
	// timer, so the write fires once the user pauses, not after the first key. A failure
	// leaves the buffer dirty, so this effect simply comes round again.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `buffer.text` is the debounce RESET — each keystroke must restart the timer, even though the body does not read it.
	useEffect(() => {
		if (!buffer.dirty) return
		const id = setTimeout(() => void settle(), AUTOSAVE_MS)
		return () => clearTimeout(id)
	}, [buffer.text, buffer.dirty, settle])

	// The scratch autosaves on the same terms as a note. It keeps typing itself to disk even
	// while a note is on screen (its machine is not the editor's), so nothing is lost by
	// switching away mid-word.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `scratch.text` is the debounce RESET, exactly as above.
	useEffect(() => {
		if (!scratch.dirty) return
		const id = setTimeout(() => void settleScratch(), AUTOSAVE_MS)
		return () => clearTimeout(id)
	}, [scratch.text, scratch.dirty, settleScratch])

	// The buffer follows `openPath`, which is the reducer's (and the agent's) idea of what
	// the user is looking at. Two triggers, one call: a different note (`openPath`), and
	// the open note changing on disk (`revision` — `reload` ignores it while dirty, since
	// the buffer is then newer than the disk). A path we cannot read is not one to stay
	// pointed at, so the buffer detaches and this says why.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is a cache-busting trigger — a bump means the open file changed on disk.
	useEffect(() => {
		if (openPath === null) return
		// A MOVE is not an open. `openPath` cannot say why it changed, so the reducer says:
		// the buffer follows the note to its new address, keeping unsaved edits, instead of
		// trying to save them to a path that no longer exists (which would fail ENOENT,
		// detach, and leave a duplicate). The GUI's own moves call `moved` directly; this is
		// the same thing for a rename the agent did.
		// Wherever the buffer's address sits on the trail, the note is at `openPath` now.
		const held = buf.snapshot().path
		if (held !== null && held !== openPath && movedFrom?.includes(held)) {
			followMove(held, openPath)
			return
		}
		// The selection can move on while a read is in flight. This effect re-runs when it
		// does, so the older run must not report on, or act for, a note nobody is looking at
		// any more — its `newNote` would overwrite the newer selection.
		let current = true
		void (async () => {
			const outcome =
				openPath === buf.snapshot().path ? await buf.reload(openPath) : await buf.open(openPath)
			if (outcome.opened || !current) return
			if (outcome.because === 'unsettled') {
				setStatus(explain(outcome.outcome))
				return
			}
			// Only a note that is GONE loses the editor's selection: a transient read failure
			// leaves the buffer attached (see `buffer.ts`), so `openPath` must stay too, or the
			// next save would go through `create` and leave a duplicate.
			setStatus(`Cannot open ${displayPath(outcome.path)} — ${outcome.error.message}`)
			if (outcome.gone) await actions.newNote({})
		})()
		return () => {
			current = false
		}
	}, [openPath, revision, movedFrom, buf, followMove, actions])

	// The reducer says nothing is open (the user pressed New, or the agent dispatched it)
	// while the buffer still holds a note. Letting go means SETTLING first, so unsaved
	// edits are written rather than dropped — and if that write cannot land, this comes
	// round again when the buffer changes, instead of leaving the editor attached to a note
	// the rest of the app considers closed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `buffer.dirty` is the RETRY trigger — a write that lands makes the buffer clean, which is when letting go can succeed.
	useEffect(() => {
		if (openPath !== null || buffer.path === null) return
		void (async () => {
			const outcome = await buf.clear()
			if (!outcome.settled) setStatus(explain(outcome))
		})()
	}, [openPath, buffer.path, buffer.dirty, buf])

	// Launch = the SCRATCH, and the caret in it (DESIGN.md §6). Reopen is still always
	// unfiled — capture-first — but "unfiled" is now a live surface rather than a placeholder,
	// so the way in is simply typing; the search field is one key away (⌘O).
	const mounted = useRef(false)
	useEffect(() => {
		if (mounted.current) return
		mounted.current = true
		if (openPath !== null) void actions.newNote({})
	}, [openPath, actions])

	// Focus follows READINESS, not mount: the scratch's text is a round trip away and the
	// editor is inert until it lands. If it cannot be read at all, the field is the fallback —
	// the same dead end every other failure lands on.
	const focusedOnce = useRef(false)
	useEffect(() => {
		if (focusedOnce.current || openPath !== null || scratchState === 'loading') return
		focusedOnce.current = true
		if (scratchState === 'failed') {
			focusSearch()
			return
		}
		// At the END of what is already there: a scratch is appended to, not overwritten.
		const el = editorRef.current
		el?.focus()
		el?.setSelectionRange(el.value.length, el.value.length)
	}, [openPath, scratchState, focusSearch])

	// The name to re-create under, kept level with the buffer's address: while it holds a
	// note, that note's name is the one its words belong to.
	//
	// And the name field's draft, which follows the WORDS and not the address — `draftSurvives`
	// in notes.ts is that rule, with every case it has been got wrong. A move is already
	// accounted for by then (`followMove` re-points as the buffer follows), so an address change
	// that reaches this is unexplained: the buffer holds a different note, and a draft for the
	// old one would rename this one.
	//
	// Here rather than at each call site: the GUI clears the draft on its own transitions, but
	// only the buffer knows when something else moved it.
	useEffect(() => {
		if (buffer.path !== null) nameRef.current = noteTitle(buffer.path)
		if (draftRef.current === null) return
		if (draftSurvives(draftForRef.current, buffer.path)) draftForRef.current = buffer.path
		else {
			setDraft(null)
			setTitleError(null)
		}
	}, [buffer.path, setDraft])

	// Reflect the open note's filename as the document title — hosts with a native
	// title bar (e.g. desktop) show it there; in quay the centered header below is
	// the visible title (the native title is hidden behind a transparent titlebar).
	useEffect(() => {
		document.title = openPath ? displayPath(openPath) : 'Notes'
	}, [openPath])

	// The list is never cached in reducer state (DESIGN.md §3) — re-scan /notes
	// whenever a surface that shows it appears (search focus, docked pane), and
	// whenever anything on disk moved it: a create/remove/rename (`treeRevision`) or a
	// write to the open note (`revision`, which reorders a newest-first list).
	const refreshTokenRef = useRef(0)
	const changeSeenRef = useRef('')
	const refresh = useCallback(async () => {
		// Scans overlap (a bump can land mid-scan), so only the newest result may win
		// — an older, smaller listing must not overwrite it.
		const token = ++refreshTokenRef.current
		const listed = await actions.list({})
		if (refreshTokenRef.current === token) setEntries(listed)
	}, [actions])

	// The dropdown and the search ranking only care about notes; the tree also
	// needs the folders, so the raw listing is what's held.
	const notes = useMemo(() => entries.filter((entry) => entry.type === 'file'), [entries])

	// A folder is a target only while the LISTING still has it — and the listing is
	// derived from disk, so a folder the agent deleted or renamed simply stops being
	// one. `null` means "gone", so callers can fall through to the next candidate; `/`
	// is the volume root and always exists. This is the only check of its kind: every
	// "create in here" goes through it, because `writeFile` auto-creates parents and
	// would otherwise resurrect a deleted folder from a stale pointer.
	const liveDir = useCallback(
		(dir: string | null): string | null =>
			dir === '/'
				? '/'
				: dir && entries.some((e) => e.type === 'dir' && e.path === dir)
					? dir
					: null,
		[entries]
	)

	// Where a new note goes: the folder selected in the tree, else beside the open note
	// (Obsidian's "same folder as the current file"), else the root — each candidate
	// only while it is still live. Derived at the moment of use, never stored: a
	// remembered folder is a second pointer to a location, and the location can go.
	const createDir = useCallback(
		() => liveDir(selectedDirRef.current) ?? liveDir(parentDir(openPath ?? '/')) ?? '/',
		[liveDir, openPath]
	)
	dirRef.current = createDir()

	// Either surface can be showing the listing: the docked pane, or the dropdown
	// palette over the editor. Both go stale the same way, so both keep it live.
	const listing = listOpen || dropOpen

	useEffect(() => {
		if (!listing) return
		// TWO signals, one refresh. `treeRevision` is a create/remove/rename anywhere
		// in `/notes`; `revision` is a write to the OPEN note, which changes its mtime
		// and therefore its place in a newest-first list and its "3m" label. A bulk
		// writer (an import, or the agent) emits thousands, and one growing full-tree
		// scan per note would swamp the app — so each bump resets the timer and the
		// scan runs once the writes stop. Opening a surface is not a bump, so it still
		// lists immediately.
		const seen = `${treeRevision}:${revision}`
		if (changeSeenRef.current === seen) {
			void refresh()
			return
		}
		changeSeenRef.current = seen
		const id = setTimeout(() => void refresh(), REFRESH_MS)
		return () => clearTimeout(id)
	}, [listing, treeRevision, revision, refresh])

	const openNote = useCallback(
		async (path: string) => {
			// Nothing may replace the buffer until it is settled; `settle` says whether it is.
			if (!(await settle())) return
			// The scratch is about to leave the screen, so its words go to disk now rather than
			// waiting out a debounce the user cannot see.
			if (!(await settleScratch())) return
			setDropOpen(false)
			setQuery('')
			setDraft(null)
			setTitleError(null)
			// Opening a note supersedes a folder click as the "where am I" hint.
			selectedDirRef.current = null
			await actions.open({ path })
			editorRef.current?.focus()
			if (listing) void refresh() // the flushed note's mtime may reorder the list
		},
		[settle, settleScratch, setDraft, actions, listing, refresh]
	)

	// Enter in the name field goes to the top of the body — Obsidian's move, and the thing
	// that makes two fields read as one document.
	const focusBody = useCallback(() => {
		const el = editorRef.current
		el?.focus()
		el?.setSelectionRange(0, 0)
	}, [])

	// One submission, however many times it is submitted. Enter REPEATS while held, and the
	// Create row stays clickable until the buffer has cleared and the surface is dismissed —
	// several frames later, because that clear is a write. Each continuation would then mint
	// its own name through `claimPath`, so one intended note becomes `Kyoto` AND `Kyoto 2`
	// (reproduced: two Enters in one tick made both). Dropped rather than queued: the second
	// press is the same submission, not another note.
	const creatingRef = useRef(false)

	// Create a note called `title` in `dir`, and open it. Three callers: the search field's
	// Create row, the tree's "New note", and the name field. The note is created EMPTY — its
	// name is not repeated in its body (DESIGN.md §4), which is what makes our notes the same
	// shape as an imported vault's.
	const createOnce = useCallback(
		async (title: string, dir: string) => {
			// Judged, not repaired — the same rule the name field keeps (DESIGN.md §4). Both
			// surfaces that reach here take a name from a person who can see it, and `create`'s
			// silent repair would offer “Trips/Kyoto” and open `Trips Kyoto.md`. The search field
			// says so on the row itself; the tree's menu has closed by now, so it says so here.
			const illegal = illegalName(title)
			if (illegal) {
				setStatus(`Cannot create “${title}” — ${illegal}`)
				return
			}
			// Land whatever was in the buffer first: a write still aimed at the last note must
			// not arrive after this one is open.
			if (!(await buf.clear()).settled) {
				await settle()
				return
			}
			if (!(await settleScratch())) return
			setDropOpen(false)
			setQuery('')
			setDraft(null)
			setTitleError(null)
			// Aim at the folder through the HINT, not by writing `dirRef` directly: every
			// render recomputes that from the hint (`createDir`), so a render between here and
			// the write — and typing causes one — would otherwise put the note back at the root.
			selectedDirRef.current = dir
			try {
				const path = await createIn(title, '', liveDir(dir) ?? '/')
				nameRef.current = noteTitle(path)
				await actions.open({ path })
			} catch (failure) {
				setStatus(
					`Could not create “${title}” — ${failure instanceof Error ? failure.message : String(failure)}`
				)
				setQuery(title) // nothing was written, so the name stays where they typed it
				return
			}
			// Focus once the buffer has rendered, cursor at the top of the empty body.
			requestAnimationFrame(focusBody)
			if (listing) void refresh()
		},
		[buf, settle, settleScratch, setDraft, createIn, liveDir, actions, focusBody, listing, refresh]
	)

	const createNote = useCallback(
		async (title: string, dir: string) => {
			if (creatingRef.current) return
			creatingRef.current = true
			try {
				await createOnce(title, dir)
			} finally {
				creatingRef.current = false
			}
		},
		[createOnce]
	)

	// A move can land somewhere other than asked (the name was taken) or be refused
	// outright (a folder into itself) — either way the user has to be told, and the
	// tree, which moved the row optimistically, has to be put back.
	//
	// Answers WHERE the note ended up, or `null` if it did not move. Not a boolean: its two
	// callers ask different questions of that one fact, and a DEDUPED move answers them
	// oppositely. The tree needs "is it at `to`" — its optimistic row is wrong if it is not —
	// while the name field needs "did it move at all", because a note that landed at
	// `Kyoto 2` has still been renamed, and the field reads its name from the buffer, so it
	// shows wherever it went. A single boolean could only have lied to one of them.
	const moveNote = useCallback(
		async (from: string, to: string): Promise<string | null> => {
			// The buffer lands at the OLD path first: a pending write afterwards would
			// recreate what we just moved. If it cannot land, the move waits — the words
			// matter more than the rename.
			const held = buf.snapshot().path
			if (held !== null && isUnder(held, from)) {
				if (!(await settle())) return null
			}
			let landed: string | null = null
			try {
				const { path } = await actions.rename({ from, to })
				// The bytes did not change, only their address — so the buffer follows, and no
				// re-read is needed when `openPath` catches up.
				followMove(from, path)
				if (path !== to) setStatus(`A note was already there — moved as “${displayPath(path)}”`)
				landed = path
			} catch (error) {
				setStatus(error instanceof Error ? error.message : String(error))
			}
			void refresh()
			return landed
		},
		[actions, buf, followMove, settle, refresh]
	)

	// What the name field shows, and whether there is anything to name. There is no such
	// thing as an unnamed note, so a note is never nameless — but the SCRATCH is, and that is
	// what the editor shows when the note buffer holds nothing at all. The one other case it
	// can hold nothing but words is a note deleted under it: those words keep the screen (they
	// are the user's, and `nameRef` still knows what they were called) until they land as a
	// note of their own, so they are not shouldered aside by the scratch.
	const onScratch = buffer.path === null && buffer.text === ''
	// Read-only only while the scratch's text is still coming (or never came). Everything else
	// — a note, or words orphaned by a delete — is always editable.
	const editable = !onScratch || scratchState === 'ready'
	// The name field belongs to a NOTE and is not rendered on the scratch at all (§6): a
	// scratch has no filename to show, so showing an empty one invites the user to name a thing
	// that does not exist yet, and "nameless" is the whole point of the surface. Naming happens
	// once, at the moment of keeping (`namePrompt` below).
	const noteName = buffer.path !== null ? noteTitle(buffer.path) : onScratch ? '' : nameRef.current
	const shownName = titleDraft ?? noteName
	// The scratch's save prompt is open. Derived from the draft, not a flag beside it.
	const naming = onScratch && titleDraft !== null

	// Keep the scratch: the words go somewhere permanent and LEAVE the scratch — a move, not
	// a copy, exactly as Emacs's `C-x C-s` in `*scratch*`, JetBrains' "move to project" and
	// Heynote's move-block-to-buffer all have it. `keep` is the destination (a named note, or
	// the day's journal) and answers where the words landed.
	//
	// THE ORDER IS THE WHOLE RULE: the create lands first, and only then is anything cut, so a
	// failure costs the gesture and nothing else. The cut itself goes through the buffer
	// machine, so a write that does not land leaves the remainder dirty and on screen rather
	// than lost (buffer.ts rule 2).
	// One keeping, however many times it is asked for. Enter REPEATS while held and the
	// journal button stays clickable across the round trip, so two calls can read the same
	// text before either has cut it — which files it twice (two numbered notes, or the same
	// entry appended twice). The same rule `createOnce` learned, at the other gesture that
	// creates: the second press is the same submission, not another note.
	const keepingRef = useRef(false)
	const promoteScratch = useCallback(
		async (
			keep: (text: string) => Promise<string>
		): Promise<{ path: string; removed: boolean } | null> => {
			if (keepingRef.current) return null
			keepingRef.current = true
			try {
				const el = editorRef.current
				const before = scratchBuf.snapshot().text
				const from = el?.selectionStart ?? 0
				const to = el?.selectionEnd ?? 0
				// A selection is the unit when there is one: a scratch accumulates several unrelated
				// things, and filing one of them must not file the other three.
				const { promoted } = splitSelection(before, from, to)
				if (promoted.trim() === '') {
					setStatus('Nothing to keep — the scratch is empty')
					return null
				}
				let path: string
				try {
					path = await keep(promoted)
				} catch (failure) {
					setStatus(
						`Could not keep this — ${failure instanceof Error ? failure.message : String(failure)}`
					)
					return null
				}
				// THE CUT IS AGAINST THE LATEST TEXT, not the snapshot the offsets came from. Filing is
				// a round trip — `create` even awaits a queue drain — and the user can type all the way
				// through it: focus stays in the body when ⌘S is pressed from there, which is the case
				// the name-waits-in-the-field rule invites. Applying the stale remainder then deletes
				// those keystrokes, and they are in NEITHER the note nor the scratch. `cutKept` maps the
				// offsets through whatever was typed and verifies them, so the words that go are the
				// ones the user selected — not the first copy of them.
				//
				// Read and write with no `await` between them, so nothing can be typed inside the
				// read-modify-write itself.
				const next = cutKept(before, scratchBuf.snapshot().text, from, to)
				if (next !== null) {
					scratchBuf.type(next)
					void settleScratch()
				}
				// `null` = the kept words cannot be identified in what the buffer holds now, because the
				// user edited them while they were in flight (or left two copies of them). The buffer is
				// left exactly as they last typed it and the caller says a copy stayed: two copies are
				// recoverable, the wrong cut is not.
				return { path, removed: next !== null }
			} finally {
				keepingRef.current = false
			}
		},
		[scratchBuf, settleScratch]
	)

	// The other half of keeping something: no name, but not lost either. One note per day,
	// appended to — the answer for words that are worth keeping and not worth naming, which is
	// most of what a scratch collects (DESIGN.md §6).
	const keepInJournal = useCallback(async () => {
		const now = new Date()
		const kept = await promoteScratch(async (text) => {
			// The clock is the GUI's: a procedure runs in the worker, where the date is UTC.
			const entry = `## ${localTimeStamp(now)}\n\n${text.trim()}`
			return (await actions.journal({ date: localDateStamp(now), text: entry })).path
		})
		if (kept === null) return
		setStatus(`Kept in ${displayPath(kept.path)}${kept.removed ? '' : ` ${COPY_STAYED}`}`)
		void refresh()
	}, [promoteScratch, actions, refresh])

	// The caret at the END of the scratch: it is appended to, not overwritten. Deferred a
	// frame, because the textarea is still showing the note it held when this is called.
	const focusScratchEnd = useCallback(() => {
		requestAnimationFrame(() => {
			const el = editorRef.current
			el?.focus()
			el?.setSelectionRange(el.value.length, el.value.length)
		})
	}, [])

	// ⌘S on a note means what it means everywhere else — land it now — and never anything
	// destructive, so the reflex is safe wherever it is pressed. (Autosave has usually done it
	// already; being told so is the point.)
	const saveNow = useCallback(async () => {
		if (await settle()) setStatus('Saved')
	}, [settle])

	// Ask for a name — the scratch's save prompt (§6). It opens in the footer, on the gesture
	// that needs it, rather than sitting above the buffer as a permanent empty field: a scratch
	// has no filename until it stops being a scratch, and the question is only worth asking
	// once, at the moment of keeping.
	//
	// `draftForRef` is set the way the first keystroke in a name field sets it, because a
	// prompt opened with no keystroke still has to say what its draft is ABOUT (see the
	// `buffer.path` effect — a stale target there would drop the name mid-type).
	const openNamePrompt = useCallback(() => {
		if (!editable) return
		draftForRef.current = buf.snapshot().path
		setDraft('')
		setTitleError(null)
		// The input mounts on the next render, so the focus waits for it.
		requestAnimationFrame(() => titleRef.current?.focus())
	}, [editable, buf, setDraft])

	// Back to the scratch. `newNote` is what makes the reducer — and the agent — say the user
	// is on it; the note buffer settles on the way out. A navigation, so it dismisses the
	// palette and drops the half-typed name with it, exactly as opening a note does.
	const showScratch = useCallback(async () => {
		if (openPath !== null) {
			if (!(await settle())) return
			await actions.newNote({})
		}
		setDropOpen(false)
		setQuery('')
		setDraft(null)
		setTitleError(null)
		focusScratchEnd()
	}, [openPath, settle, actions, setDraft, focusScratchEnd])

	// Where the name field lands, and whether it landed. Three answers, not two, because a
	// name can fail in two unrelated ways:
	//
	//   • REFUSED — the name itself is unusable (illegal, or taken). Nothing was attempted, so
	//     the draft is a mistake to fix: Enter keeps it in the field with the reason under it,
	//     while a blur reverts (fighting a click for focus is worse than dropping a name that
	//     was never applied) and says so in the status line.
	//   • DID NOT LAND — the name is fine and the volume would not cooperate (a pending body
	//     save that will not settle, a rename that threw). The draft is then the only record of
	//     what the user wanted, so it STAYS — the same rule the buffer machine keeps for bytes:
	//     a write that did not land leaves what it was carrying exactly where it was. The
	//     status line carries the volume's own words; the field is not marked invalid, because
	//     nothing is wrong with the name.
	//
	// So the draft is cleared only once the rename (or the recreation) is really on disk.
	const commitTitle = useCallback(
		async (raw: string, keep: boolean): Promise<boolean> => {
			const held = buf.snapshot().path
			const name = raw.trim()
			const revert = () => {
				setDraft(null)
				setTitleError(null)
			}
			// A name that cannot be used. Enter keeps the draft in the field with the reason under
			// it — that is where the user is, and it is what they are about to fix; a blur reverts
			// and says so in the status line, because fighting a click for focus is worse than
			// dropping a name that was never applied.
			const refuse = (why: string) => {
				if (keep) setTitleError(why)
				else {
					revert()
					setStatus(why)
				}
				return false
			}
			// Cleared, or unchanged: the field goes back to showing what is on disk. Neither is
			// an error — emptying the field is not a request for a nameless note, there is no
			// such thing.
			if (name === '' || name === noteName) {
				revert()
				return true
			}
			// Judged before anything is derived from it: a name with a `/` in it that happens to
			// sanitize back to the note's current one must still be refused, not quietly accepted
			// as a no-op.
			const illegal = illegalName(name)
			if (illegal) return refuse(illegal)
			const clean = sanitizeName(name)
			// The destination the reducer would compute, so the questions below are asked about the
			// path the write will actually take — including the extension a `.txt` note keeps.
			const target =
				held !== null
					? renameTarget(held, joinPath(parentDir(held), clean), true)
					: joinPath(dirRef.current, `${clean}${NOTE_EXT}`)
			// A tidy that lands where the note already is: `Kyoto  trip` collapses to `Kyoto trip`,
			// which is neither a rename nor a clash with itself. Asked of the TARGET, because the
			// collapse is exactly what makes it differ from the typed name checked above.
			if (target === held) {
				revert()
				return true
			}
			// Advisory, and knowingly so: it reads a listing, which is a snapshot, so `claimPath`
			// in the reducer stays the authority and still numbers rather than overwrites. What
			// this buys is the common case — telling someone the name is taken while they are
			// still in the field, instead of moving their note to “Kyoto 2” behind their back. A
			// name taken in the instant between here and the write is reported by `moveNote`.
			if (entries.some((entry) => entry.path === target))
				return refuse(`“${clean}” already exists here`)
			// A note that exists is RENAMED — through the same `rename` the tree and the agent
			// use, so the extension rule and the no-overwrite rule cannot disagree. With no note,
			// there are two ways to be nameless and they are opposites: the SCRATCH is words nobody
			// has filed, so naming it FILES them (a create, and the words leave the scratch); a
			// buffer whose note was deleted under it is words that were already filed, so naming
			// them only says where they should land again and the settle is what lands them.
			// `nameRef` is set BEFORE that settle (it is where the create reads the name) and stays
			// set if it fails, so the retry uses the name the user chose.
			let landed: boolean
			// `moveNote` answers with the path, which is more than this needs: a note deduped to
			// `Kyoto 2` HAS been renamed, and the field will show that name because it reads it
			// from the buffer. Only "it did not move at all" keeps the draft.
			if (held !== null) landed = (await moveNote(held, target)) !== null
			else if (onScratch) {
				const kept = await promoteScratch((text) => createIn(clean, text, dirRef.current))
				if (kept !== null) {
					// Two things can be worth saying, and the copy is the actionable one. The advisory
					// above reads a listing that may be empty (nothing has asked for one yet) or stale,
					// and `claimPath` numbers rather than overwrites — so the name chosen at the moment of
					// filing can still be taken. Say where the words actually went; the same thing
					// `moveNote` says about a deduped rename.
					if (!kept.removed) setStatus(`Kept as “${displayPath(kept.path)}” ${COPY_STAYED}`)
					else if (noteTitle(kept.path) !== clean)
						setStatus(
							`A note called “${clean}” already existed — kept as “${displayPath(kept.path)}”`
						)
					await actions.open({ path: kept.path })
					if (listing) void refresh()
				}
				landed = kept !== null
			} else {
				nameRef.current = clean
				landed = await settle()
			}
			if (landed) revert()
			return landed
		},
		[
			buf,
			noteName,
			entries,
			setDraft,
			moveNote,
			settle,
			onScratch,
			promoteScratch,
			createIn,
			actions,
			listing,
			refresh
		]
	)

	// Commit whatever the scratch's save prompt holds — the same `commitTitle` the name field
	// uses, so the illegal-name rule, the "already exists" advisory and the three-answer failure
	// handling are one path on both surfaces. Only the input differs.
	const commitName = useCallback(async () => {
		// An empty name is not a request for a nameless note (there is no such thing) — it is a
		// cancel, and the caret goes back to the end of the words it was going to name.
		if ((draftRef.current ?? '').trim() === '') {
			setDraft(null)
			setTitleError(null)
			focusScratchEnd()
			return
		}
		// A successful keep leaves the NEW NOTE on screen, so the caret belongs at the top of it.
		if (await commitTitle(draftRef.current ?? '', true)) focusBody()
	}, [commitTitle, setDraft, focusBody, focusScratchEnd])

	// Enter names it; Esc abandons the prompt and goes back to the words. Blur does NOT commit
	// (§6): clicking into the body is not a request to keep anything, so the name waits.
	const onNameKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			e.preventDefault()
			void commitName()
		} else if (e.key === 'Escape') {
			e.preventDefault()
			setDraft(null)
			setTitleError(null)
			focusScratchEnd()
		}
	}

	// The menu is already closed by the time this runs, so a failure has nowhere to appear
	// but the status line — and "the name is taken by a note" is a thing users do.
	const createFolder = useCallback(
		async (path: string): Promise<boolean> => {
			try {
				await actions.mkdir({ path })
				return true
			} catch (failure) {
				setStatus(
					`Could not create ${displayPath(path)} — ${failure instanceof Error ? failure.message : String(failure)}`
				)
				return false
			}
		},
		[actions]
	)

	const moveOpenNote = useCallback(
		async (dir: string, create: boolean): Promise<boolean> => {
			const from = buf.snapshot().path
			if (from === null) return false
			if (create && !(await createFolder(dir))) return false
			const filename = from.slice(from.lastIndexOf('/') + 1)
			return (await moveNote(from, joinPath(dir, filename))) !== null
		},
		[buf, createFolder, moveNote]
	)

	const removeNote = useCallback(
		async (path: string) => {
			// Deleting the open note DISCARDS its buffer — settling it would write the note
			// straight back, and the machine also cancels a read in flight for it. Discarded
			// BEFORE the delete for that reason, and put back if the delete does not happen:
			// a failed remove must not cost the user the note *and* their unsaved edits. The
			// machine hands back the way in, so deleting a DIFFERENT note cannot restore over
			// the one being edited.
			const undiscard = buf.discard(path)
			try {
				await actions.remove({ path })
			} catch (failure) {
				undiscard?.()
				setStatus(
					`Could not delete ${displayPath(path)} — ${failure instanceof Error ? failure.message : String(failure)}`
				)
				return
			}
			setActive(0)
			// The editor just went inert (the note it held is gone), so put the user where a note
			// begins rather than in a field that cannot be typed into.
			if (undiscard) focusSearch()
			void refresh()
		},
		[actions, buf, focusSearch, refresh]
	)

	// Import a drop: unzip + plan in the GUI, write in chunks through the reducer
	// (DESIGN.md §10). The vault's contents MERGE into the knowledge base root — no
	// wrapper folder — and a name that is already taken lands beside it as `… 2`.
	const importDrop = useCallback(
		async (files: File[]) => {
			if (files.length === 0) return
			// Progress lives OUTSIDE the try: an import writes as it goes, so a failure
			// half way through is a partial import, not a failed one, and saying "failed"
			// hides notes that are already on disk (and that a retry would number as
			// duplicates, since an import never overwrites).
			let written = 0
			let renamed = 0
			let failed = 0
			let total = 0
			try {
				setStatus('Reading…')
				const plan = await planDrop(files)
				if (plan.skipped > 0) console.info('[notes] import skipped', plan.skipped, plan.examples)
				if (plan.files.length === 0) {
					// `stopped` with nothing kept means we gave up walking, not that the drop
					// held no notes — say which, or the user retries the same archive forever.
					setStatus(
						plan.stopped
							? `Nothing imported — gave up after ${plan.members} entries, none of them notes`
							: `Nothing to import — no .md or .txt files (${plan.skipped} skipped)`
					)
					return
				}
				total = plan.files.length
				for (let at = 0; at < total; at += IMPORT_CHUNK) {
					const result = await actions.importNotes({
						files: plan.files.slice(at, at + IMPORT_CHUNK)
					})
					written += result.written
					renamed += result.renamed
					failed += result.failed
					setStatus(`Importing… ${written}/${total}`)
				}
				const extra = [
					`${plan.folders} folder${plan.folders === 1 ? '' : 's'}`,
					...(plan.skipped > 0 ? [`${plan.skipped} skipped`] : []),
					...(renamed > 0 ? [`${renamed} renamed to avoid a clash`] : []),
					...(failed > 0 ? [`${failed} could not be written`] : [])
				]
				setStatus(
					`${plan.stopped ? 'Partly imported' : 'Imported'} ${written} note${written === 1 ? '' : 's'} from ${plan.name} (${extra.join(', ')}${plan.stopped ? ' — too large, the rest was left out' : ''})`
				)
				if (!listOpen) setListOpen(true)
				void refresh()
			} catch (error) {
				const why = error instanceof Error ? error.message : String(error)
				setStatus(
					written > 0
						? `Imported ${written} of ${total} notes, then stopped: ${why}`
						: `Import failed: ${why}`
				)
				if (written > 0) void refresh()
			}
		},
		[actions, listOpen, refresh]
	)

	// The report is a notice, not state — it clears itself.
	useEffect(() => {
		if (status === null || status.startsWith('Importing') || status === 'Reading…') return
		const id = setTimeout(() => setStatus(null), STATUS_MS)
		return () => clearTimeout(id)
	}, [status])

	const toggleList = useCallback(() => {
		const next = !listOpen
		setListOpen(next)
		setDropOpen(false)
		writePref(LIST_PREF_KEY, next ? '1' : '0')
		// The search field remounts across the bar/pane move, dropping focus —
		// land it on the editor so root-scoped shortcuts keep working.
		editorRef.current?.focus()
	}, [listOpen])

	// The splitter: drag (or arrow-key) the pane's width. Pointer capture keeps the
	// drag alive over the editor and the tree's shadow root; the width is a
	// GUI-local preference, like the pane toggle itself.
	const bodyRef = useRef<HTMLDivElement>(null)
	const onSplitterDown = (e: React.PointerEvent<HTMLDivElement>) => {
		e.preventDefault()
		e.currentTarget.setPointerCapture(e.pointerId)
		setDragging(true)
	}
	const onSplitterMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
		const left = bodyRef.current?.getBoundingClientRect().left ?? 0
		setListWidth(clampWidth(e.clientX - left))
	}
	const onSplitterUp = (e: React.PointerEvent<HTMLDivElement>) => {
		e.currentTarget.releasePointerCapture(e.pointerId)
		setDragging(false)
		writePref(WIDTH_PREF_KEY, String(listWidth))
	}
	const onSplitterKey = (e: React.KeyboardEvent) => {
		const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0
		if (step === 0) return
		e.preventDefault()
		const next = clampWidth(listWidth + step)
		setListWidth(next)
		writePref(WIDTH_PREF_KEY, String(next))
	}

	// Webview flush gotcha (DESIGN.md §4): the window can tear down before a save
	// lands. Best-effort flush as the page hides; the host's windowShouldClose path
	// awaits the real final flush.
	// Both listeners come off again: an anonymous one cannot, so it outlived every remount
	// inside the shared shell document and a later page hide would settle a buffer from a
	// dead instance over what the live one had written.
	useEffect(() => {
		const onHide = () => {
			void settle()
			void settleScratch()
		}
		// A tab switch is not a teardown, so that one flushes only when actually hidden.
		const onVisibility = () => {
			if (document.visibilityState === 'hidden') onHide()
		}
		window.addEventListener('pagehide', onHide)
		document.addEventListener('visibilitychange', onVisibility)
		return () => {
			window.removeEventListener('pagehide', onHide)
			document.removeEventListener('visibilitychange', onVisibility)
		}
	}, [settle, settleScratch])

	const filtered = useMemo(() => matchNotes(notes, query.trim()), [notes, query])
	// A note is born named, so the search field is where naming happens: whatever is typed is
	// offered as a note to create, on a row of its own after the matches. Offered even when
	// something DOES match — `Kyoto trip` matching is exactly why `Kyoto` would otherwise be
	// uncreatable — and reachable with ArrowDown, so it costs no second shortcut.
	// Judged as it is typed, by the same rule the name field uses. The ROW is where the answer
	// belongs: a name that cannot be used says so instead of offering itself, rather than being
	// silently repaired into a note called something else.
	const creatable = query.trim()
	const createProblem = creatable ? illegalName(creatable) : null
	const canCreate = creatable !== '' && createProblem === null
	const rowCount = filtered.length + (canCreate ? 1 : 0)
	// Which row the keyboard is on. Clamped rather than reset, because the listing is live:
	// results disappearing under the user must not move their place any further than it has
	// to, and must never leave it pointing past the end.
	const selected = Math.min(active, rowCount - 1)
	const creating = canCreate && selected === filtered.length

	// Shortcuts are scoped to the app root, not `window` — app windows share the
	// shell's document (no iframe), so a window listener would fire even when
	// another window has focus, and ⌘K must stay the shell omnibar's (DESIGN.md
	// §5). ⌘O and ⌘N are the SAME shortcut now: both mean "go to the field where a
	// note is found or named". ⌘O is the one that works everywhere — browsers reserve
	// ⌘N for a new window and never deliver it — and ⌘N costs two characters to keep
	// for the hosts that do (desktop webview).
	//
	// ⌘S is "keep this", and ⌘J is "jot" — back to the scratch. Both are DELIVERED to the
	// page and cancellable, unlike ⌘N: ⌘S's browser default (save the page) is suppressed by
	// `preventDefault`, and the desktop shell binds only ⌘W/⌘Q natively, so nothing upstream
	// swallows either. Digits were the obvious choice for "go to the scratch" and are
	// unusable: ⌘1–9 switches browser tabs and cannot be prevented.
	const onRootKey = (e: React.KeyboardEvent) => {
		if (e.defaultPrevented) return
		if ((e.metaKey || e.ctrlKey) && (e.key === 'o' || e.key === 'n')) {
			e.preventDefault()
			focusSearch()
		} else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
			e.preventDefault()
			if (!onScratch) {
				void saveNow()
				return
			}
			// Keeping the scratch has exactly one question — what is it called — and ⌘S is how it
			// gets asked: no prompt yet, open one; a name already typed, take it; open but empty,
			// put the caret back in it. It never invents a name.
			if (draftRef.current === null) {
				openNamePrompt()
			} else if (draftRef.current.trim() === '') {
				titleRef.current?.focus()
			} else {
				void commitName()
			}
		} else if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
			e.preventDefault()
			void showScratch()
		} else if (e.key === 'Escape' && e.target === editorRef.current) {
			// The nvAlt loop: Esc hops editor → search; Esc in the field hops back.
			e.preventDefault()
			focusSearch()
		}
	}

	// The name field commits on Enter or blur, never on a keystroke: one rename per name, not
	// one per letter (DESIGN.md §4). Esc abandons the draft — and both keys leave the field,
	// which is why the draft is held in a ref as well (see `setDraft`).
	const onTitleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			e.preventDefault()
			void (async () => {
				if (await commitTitle(draftRef.current ?? noteName, true)) focusBody()
			})()
		} else if (e.key === 'Escape') {
			e.preventDefault()
			setDraft(null)
			setTitleError(null)
			focusBody()
		}
	}

	const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'ArrowDown') {
			e.preventDefault()
			setActive((i) => Math.min(i + 1, rowCount - 1))
		} else if (e.key === 'ArrowUp') {
			e.preventDefault()
			setActive((i) => Math.max(i - 1, 0))
		} else if (e.key === 'Enter') {
			e.preventDefault()
			// Creating belongs to the Create ROW — never to a missing index. The listing is live,
			// so results can vanish under a selection that was pointing at one, and "there is
			// nothing at this index" would then mean "make a new note" while matches are still on
			// screen.
			if (creating) void createNote(creatable, createDir())
			else {
				const note = filtered[selected]
				if (note) void openNote(note.path)
			}
		} else if (e.key === 'Delete') {
			e.preventDefault()
			const note = creating ? undefined : filtered[selected]
			if (note) void removeNote(note.path)
		} else if (e.key === 'Escape') {
			e.preventDefault()
			setDropOpen(false)
			editorRef.current?.focus()
		}
	}

	// Naming a new note is ONE row, in whichever surface is showing: appended to the
	// dropdown's results, and pinned under the pane's header — the tree shows the matches
	// there but has no row of its own to offer. One element, so Enter and a click cannot come
	// to mean different things.
	const createRow = createProblem ? (
		<div className="notes-empty notes-create-problem">
			Cannot create “{creatable}” — {createProblem}
		</div>
	) : canCreate ? (
		<button
			type="button"
			className="ds-menu-item notes-item"
			ref={searchFocused && creating ? activeRowRef : undefined}
			data-active={searchFocused && creating}
			onMouseEnter={() => setActive(filtered.length)}
			onClick={() => void createNote(creatable, createDir())}
		>
			<span className="notes-item-title">Create “{creatable}”</span>
			{creating ? <span className="notes-item-mtime">Return</span> : null}
		</button>
	) : null

	// The scratch as a PLACE in the list — one element, pinned into both surfaces that show
	// the listing, exactly as the Create row is (see `createRow`). Three jobs, which is why it
	// is a row and not another glyph in the bar:
	//
	//   • it is the way back that can be SEEN, so returning is not a shortcut you had to know;
	//   • it says what is in there (the first line, or "empty"), so a scratch with words waiting
	//     is visible from a note — a button could not;
	//   • it carries ⌘J, so the visible affordance is where the shortcut is learned.
	//
	// Deliberately OUTSIDE the keyboard row set (`rows` indices are the filtered notes and the
	// Create row): the scratch is not a search result, arrowing through results must not stop
	// on it, and ⌘J is already its key. Pinned rather than filtered, because it is a place
	// rather than a match — the same reason the pane's Create row sits outside the tree.
	const scratchLine = scratch.text.trim().split('\n', 1)[0]?.trim() ?? ''
	const scratchRow = (
		<button
			type="button"
			className="ds-menu-item notes-item notes-scratch-row"
			data-open={onScratch || undefined}
			title="The scratch buffer — unfiled text that persists"
			onClick={() => void showScratch()}
		>
			<span className="notes-item-title">
				Scratch
				<span className="notes-scratch-preview">{scratchLine === '' ? 'empty' : scratchLine}</span>
			</span>
			<span className="notes-item-mtime">{isMac ? '⌘J' : 'Ctrl+J'}</span>
		</button>
	)

	// The same rows serve both surfaces: the dropdown under the bar and the
	// docked pane. `data-active` (the ds-menu highlight) tracks keyboard nav
	// while the field is focused; the open note's title is just set in bold.
	const rows = (
		<>
			{scratchRow}
			{filtered.map((note, i) => (
				<button
					type="button"
					key={note.path}
					className="ds-menu-item notes-item"
					ref={searchFocused && i === selected ? activeRowRef : undefined}
					data-active={searchFocused && i === selected}
					data-open={note.path === openPath || undefined}
					onMouseEnter={() => setActive(i)}
					onClick={() => void openNote(note.path)}
				>
					<span className="notes-item-title">{displayPath(note.path)}</span>
					<span className="notes-item-mtime">{relativeTime(note.mtime)}</span>
				</button>
			))}
			{createRow ??
				(filtered.length === 0 ? (
					<div className="notes-empty">No notes yet — type a name to make one</div>
				) : null)}
		</>
	)

	// One search field, one toggle — rendered in the bar when the list is closed,
	// or at the top of the docked pane when it's open (the pane owns search; the
	// editor side is pure content).
	const toggleButton = (
		<button
			type="button"
			aria-pressed={listOpen}
			title={listOpen ? 'Hide the note list' : 'Show the note list'}
			onClick={toggleList}
		>
			☰
		</button>
	)
	const searchField = (
		<div className="notes-search">
			<input
				ref={searchRef}
				placeholder="Search or create…"
				value={query}
				onChange={(e) => {
					setQuery(e.target.value)
					setActive(0)
					if (!listOpen) setDropOpen(true)
				}}
				onFocus={() => {
					setSearchFocused(true)
					setActive(0)
					if (!listOpen) setDropOpen(true)
					void refresh()
				}}
				onBlur={() => setSearchFocused(false)}
				onKeyDown={onSearchKey}
			/>
			{query === '' && !searchFocused ? (
				<span className="notes-kbd" aria-hidden="true">
					{isMac ? '⌘O' : 'Ctrl+O'}
				</span>
			) : null}
		</div>
	)

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the root relays app shortcuts (⌘O/⌘N/⌘S/⌘J/Esc) from its focusable children and accepts dropped files; tabIndex -1 keeps it out of the tab order.
		<div
			className="notes"
			onKeyDown={onRootKey}
			tabIndex={-1}
			data-file-drop={fileDrop || undefined}
			// A dropped file is an import, accepted wherever it lands — pane, editor or
			// bar. Internal row drags carry `text/plain`, not `Files`, so the tree's own
			// move-drop never reaches here (DESIGN.md §10).
			onDragOver={(e) => {
				if (!Array.from(e.dataTransfer.types).includes('Files')) return
				e.preventDefault()
				e.dataTransfer.dropEffect = 'copy'
				setFileDrop(true)
			}}
			onDragLeave={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileDrop(false)
			}}
			onDrop={(e) => {
				if (!Array.from(e.dataTransfer.types).includes('Files')) return
				e.preventDefault()
				setFileDrop(false)
				void importDrop(Array.from(e.dataTransfer.files))
			}}
		>
			{!listOpen ? (
				<div className="notes-bar">
					{toggleButton}
					{searchField}
				</div>
			) : null}
			{status ? <p className="notes-status">{status}</p> : null}
			<div className="notes-body" ref={bodyRef} data-dragging={dragging || undefined}>
				{listOpen ? (
					<div className="notes-side" style={{ width: listWidth }}>
						<div className="notes-side-head">
							{toggleButton}
							{searchField}
						</div>
						<div className="notes-side-scratch">{scratchRow}</div>
						{createRow ? <div className="notes-side-create">{createRow}</div> : null}
						<NotesTree
							entries={entries}
							openPath={openPath}
							query={query}
							onOpen={(path) => void openNote(path)}
							onSelectDir={(dir) => {
								selectedDirRef.current = dir
							}}
							onCreate={(dir, title) => void createNote(title, dir)}
							onMkdir={(path) => void createFolder(path)}
							onRename={moveNote}
							onRemove={(path) => void removeNote(path)}
						/>
					</div>
				) : null}
				{listOpen ? (
					// An <hr> IS the separator element; focusable + arrow keys make it a splitter widget.
					<hr
						className="notes-splitter"
						aria-orientation="vertical"
						aria-label="Resize the note list"
						aria-valuenow={listWidth}
						aria-valuemin={WIDTH_MIN}
						aria-valuemax={WIDTH_MAX}
						tabIndex={0}
						onPointerDown={onSplitterDown}
						onPointerMove={onSplitterMove}
						onPointerUp={onSplitterUp}
						onKeyDown={onSplitterKey}
						onDoubleClick={() => {
							setListWidth(WIDTH_DEFAULT)
							writePref(WIDTH_PREF_KEY, String(WIDTH_DEFAULT))
						}}
					/>
				) : null}
				<div className="notes-doc">
					{/* The name field — a NOTE's, and only a note's. It is not the first line of the
					    file: the body on disk holds no title at all, which is what makes a note we made
					    and a note imported from an Obsidian vault the same shape (DESIGN.md §4). It only
					    looks like a first line, exactly as Obsidian's inline title does.

					    The scratch has none: it is not a file the user named, so an empty name line
					    above it would be a field for a thing that does not exist yet, permanently
					    inviting a decision the surface exists to postpone. Its name is asked for once,
					    in the footer, at the moment of keeping (DESIGN.md §6). */}
					{onScratch ? null : (
						<div className="notes-title-row">
							<input
								ref={titleRef}
								className="notes-title"
								aria-label="Note name"
								placeholder="Untitled"
								value={shownName}
								aria-invalid={titleError !== null || undefined}
								aria-describedby={titleError ? 'notes-title-error' : undefined}
								onChange={(e) => {
									// The first keystroke fixes what this draft is ABOUT — the words the buffer is
									// holding, named by wherever they live right now (see the `buffer.path` effect).
									if (draftRef.current === null) draftForRef.current = buffer.path
									setDraft(e.target.value)
									setTitleError(null)
								}}
								onKeyDown={onTitleKey}
								onBlur={() => {
									if (draftRef.current !== null) void commitTitle(draftRef.current, false)
								}}
							/>
							{buffer.path ? (
								<MoveNoteControl
									path={buffer.path}
									entries={entries}
									onOpen={() => void refresh()}
									onMove={moveOpenNote}
								/>
							) : null}
						</div>
					)}
					{titleError && !onScratch ? (
						<p className="notes-title-error" id="notes-title-error">
							{titleError}
						</p>
					) : null}
					<textarea
						ref={editorRef}
						className="notes-editor"
						// Inert only while the scratch's text is still on its way from disk (or never
						// arrived): keystrokes typed over an unfinished read would be saved on top of the
						// words being read. A note, and words orphaned by a delete, are always editable.
						readOnly={!editable}
						placeholder={
							onScratch
								? `Scratch — type anything. ${isMac ? '⌘S' : 'Ctrl+S'} to keep it as a note.`
								: 'Start typing…'
						}
						// One textarea, whichever buffer is live: they are never both on screen, and the
						// focus/selection the promote gesture reads is the same element's either way.
						value={onScratch ? scratch.text : buffer.text}
						onChange={(e) => (onScratch ? scratchBuf : buf).type(e.target.value)}
						onBlur={() => void (onScratch ? settleScratch() : settle())}
						// Clicking into the editor dismisses an open dropdown (there's no backdrop).
						onMouseDown={() => {
							if (dropOpen) setDropOpen(false)
						}}
					/>
					{onScratch ? (
						<div className="notes-scratch-foot">
							{/* The footer is where the scratch's ONE decision lives: keep this, and if so,
							    under what name. It swaps to the name prompt in place — the tree's CRUD menu
							    does the same thing (DESIGN.md §5), and sandboxed iframes have no
							    `allow-modals`, so an inline field is the only prompt there is. */}
							{naming ? (
								<div className="notes-scratch-name">
									<input
										ref={titleRef}
										aria-label="Name for the new note"
										placeholder="Name it, then Return — Esc to cancel"
										value={titleDraft ?? ''}
										aria-invalid={titleError !== null || undefined}
										aria-describedby={titleError ? 'notes-title-error' : undefined}
										onChange={(e) => {
											setDraft(e.target.value)
											setTitleError(null)
										}}
										onKeyDown={onNameKey}
									/>
									<button type="button" onClick={() => void commitName()}>
										Save
									</button>
								</div>
							) : (
								<>
									<span>Scratch — not filed anywhere</span>
									<span className="notes-scratch-acts">
										<button
											type="button"
											disabled={!editable || scratch.text.trim() === ''}
											title={`Keep this as a note under a name you choose (${isMac ? '⌘S' : 'Ctrl+S'})`}
											onClick={openNamePrompt}
										>
											Save as note…
										</button>
										<button
											type="button"
											disabled={!editable || scratch.text.trim() === ''}
											title="Append this to the day’s note instead of naming it"
											onClick={() => void keepInJournal()}
										>
											Keep in today’s note
										</button>
									</span>
								</>
							)}
							{titleError ? (
								<p className="notes-title-error" id="notes-title-error">
									{titleError}
								</p>
							) : null}
						</div>
					) : null}
				</div>
				{dropOpen && !listOpen ? <div className="ds-menu notes-results">{rows}</div> : null}
			</div>
		</div>
	)
}
