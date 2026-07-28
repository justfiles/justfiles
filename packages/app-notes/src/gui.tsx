import type { GUIProps } from '@justfiles/app/react'
import type { AsyncFlateStreamHandler, UnzipDecoder, UnzipDecoderConstructor } from 'fflate'
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Entry, NotesApp } from './app.ts'
import {
	admit,
	createScreen,
	type ImportEntry,
	type ImportPlan,
	MAX_BYTES,
	planImport,
	type Screen,
	screenEntry
} from './import.ts'
import { displayPath, isUnder, matchNotes, parentDir } from './notes.ts'
import { NotesTree } from './tree.tsx'
import './style.css'

const AUTOSAVE_MS = 800
// A bulk writer bumps `treeRevision` per file; wait for the burst to end before
// re-scanning. Short enough that a single agent write still feels immediate.
const REFRESH_MS = 250
// One import call per batch of notes: big enough to keep the round trips down,
// small enough that the status line moves and one message stays modest.
const IMPORT_CHUNK = 50
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
						screen.skip(name, 'attachment')
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
		if (entry.name.endsWith('/')) return
		// A cheap pre-check, from the local header: skip what we can already tell we
		// don't want, so it is never inflated. The header's size is a CLAIM though —
		// a streamed archive may declare 0 — so nothing is charged to the budget here.
		const declared = screenEntry(entry.name, entry.originalSize ?? 0)
		if (declared) {
			screen.skip(entry.name, declared)
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
				const entered = admit({ path: entry.name, bytes: concat(parts, size) }, screen)
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
		unzipper.push(value)
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
	const { openPath, revision = 0, treeRevision = 0, error } = state

	// The editor buffer is transient GUI-local state; the body bytes never enter
	// the reducer. `dirty` tracks unsaved edits (DESIGN.md §3).
	const [text, setText] = useState('')
	const [dirty, setDirty] = useState(false)

	// The bar's search field doubles as the palette (DESIGN.md §5): focusing it
	// drops the recency list down; typing filters; Enter opens-or-creates. The
	// docked list pane is the same list, pinned — a GUI-local preference.
	const [query, setQuery] = useState('')
	const [searchFocused, setSearchFocused] = useState(false)
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

	// Refs so async flushes/effects read the latest values without re-binding.
	const liveRef = useRef({ text, openPath, dirty, dir: '/' })
	liveRef.current = { text, openPath, dirty, dir: '/' } // `dir` filled in below
	const loadedRef = useRef<string | null>(null) // path whose body is in the buffer
	const pendingPathRef = useRef<string | null>(null) // created path before the state push catches up
	const creatingRef = useRef(false)
	const readTokenRef = useRef(0)
	const editorRef = useRef<HTMLTextAreaElement>(null)
	const searchRef = useRef<HTMLInputElement>(null)

	// Persist the dirty buffer. Correctness comes from flush-if-dirty on every
	// transition (switch, new note, blur, close); the debounce is only a perf win
	// (DESIGN.md §4). A blank scratch becomes a real file as soon as it holds any
	// non-whitespace content — an empty/whitespace buffer is never written.
	const flush = useCallback(async () => {
		const { text, dirty } = liveRef.current
		if (!dirty) return
		const path = liveRef.current.openPath ?? pendingPathRef.current
		if (path) {
			setDirty(false)
			await actions.save({ path, text })
			return
		}
		if (text.trim().length > 0 && !creatingRef.current) {
			creatingRef.current = true
			setDirty(false)
			try {
				const settled = await actions.create({ text, dir: liveRef.current.dir })
				if (settled.openPath) {
					pendingPathRef.current = settled.openPath
					loadedRef.current = settled.openPath
				}
			} finally {
				creatingRef.current = false
			}
		}
	}, [actions])

	// Load the open note's body when the selection changes, and re-read it when
	// the file changes on disk (a `revision` bump from an agent/Files edit). A
	// token drops stale reads if the user switches notes mid-flight.
	// biome-ignore lint/correctness/useExhaustiveDependencies: revision is a cache-busting trigger — a bump means the open file changed on disk, so re-read even though the body doesn't reference it.
	useEffect(() => {
		if (openPath === null) {
			pendingPathRef.current = null
			loadedRef.current = null
			setText('')
			setDirty(false)
			return
		}
		// A `revision` bump from our OWN autosave (writeFile re-fires the watch) must
		// not clobber edits typed since the flush — only reload disk when not dirty.
		// Checked again when the read resolves: a local create may race this effect
		// (the state push can render before the creator assigns loadedRef), so the
		// buffer can become the newer truth while the read is in flight.
		if (loadedRef.current === openPath && liveRef.current.dirty) return
		const token = ++readTokenRef.current
		void actions.readNote({ path: openPath }).then((result) => {
			if (readTokenRef.current !== token) return
			if (loadedRef.current === openPath && liveRef.current.dirty) return
			setText(result.text)
			setDirty(false)
			loadedRef.current = openPath
		})
	}, [openPath, revision, actions])

	// Debounced autosave: `text` is the reset trigger — each keystroke restarts
	// the timer, so the flush fires once the user pauses, not after the first key.
	// biome-ignore lint/correctness/useExhaustiveDependencies: text drives the debounce reset even though the body reads it via liveRef, not directly.
	useEffect(() => {
		if (!dirty) return
		const id = setTimeout(() => void flush(), AUTOSAVE_MS)
		return () => clearTimeout(id)
	}, [text, dirty, flush])

	// Launch = blank editor (DESIGN.md §5). Reopen is always blank — capture-first.
	const mounted = useRef(false)
	useEffect(() => {
		if (mounted.current) return
		mounted.current = true
		if (openPath !== null) void actions.newNote({})
		editorRef.current?.focus()
	}, [openPath, actions])

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
	liveRef.current.dir = createDir()

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
			await flush()
			setDropOpen(false)
			setQuery('')
			// Opening a note supersedes a folder click as the "where am I" hint.
			selectedDirRef.current = null
			await actions.open({ path })
			editorRef.current?.focus()
			if (listing) void refresh() // the flushed note's mtime may reorder the list
		},
		[flush, actions, listing, refresh]
	)

	const startNewNote = useCallback(async () => {
		await flush()
		setDropOpen(false)
		setQuery('')
		// Clear the buffer directly: when already on a blank note (openPath null),
		// newNote() doesn't change openPath, so the read effect won't fire — without
		// this, "New" on a fresh note would be a no-op.
		setText('')
		setDirty(false)
		pendingPathRef.current = null
		loadedRef.current = null
		await actions.newNote({})
		editorRef.current?.focus()
		if (listOpen) void refresh()
	}, [flush, actions, listOpen, refresh])

	// Create a note whose first line — and therefore filename — is `title`. Two
	// callers: Enter on an empty result set (the nvAlt move: search and create are
	// one gesture) and the tree's "New note", which names it inline. Both land it
	// in a folder, like Obsidian's "same folder as the current file".
	const createNote = useCallback(
		async (title: string, dir: string) => {
			await flush()
			setDropOpen(false)
			setQuery('')
			const body = `${title}\n`
			creatingRef.current = true
			try {
				// Re-checked here, not only where the dir was picked: a tree row's folder can
				// be gone by the time the name is typed, and this is the last moment before
				// `writeFile` would recreate it.
				const settled = await actions.create({ text: body, dir: liveDir(dir) ?? '/' })
				if (settled.openPath) {
					pendingPathRef.current = settled.openPath
					loadedRef.current = settled.openPath
				}
			} finally {
				creatingRef.current = false
			}
			setText(body)
			setDirty(false)
			// Focus once the buffer has rendered, cursor on the line under the title.
			requestAnimationFrame(() => {
				const el = editorRef.current
				el?.focus()
				el?.setSelectionRange(el.value.length, el.value.length)
			})
			if (listing) void refresh()
		},
		[flush, actions, liveDir, listing, refresh]
	)

	// A move can land somewhere other than asked (the name was taken) or be refused
	// outright (a folder into itself) — either way the user has to be told, and the
	// tree, which moved the row optimistically, has to be put back.
	const moveNote = useCallback(
		async (from: string, to: string) => {
			// Land a dirty buffer at the OLD path FIRST. Otherwise the pending save
			// (debounce or blur) writes after the move — recreating the file we just
			// moved — or the read effect replaces the buffer with the last saved body
			// when `openPath` follows the move.
			if (liveRef.current.openPath && isUnder(liveRef.current.openPath, from)) await flush()
			try {
				const { path } = await actions.rename({ from, to })
				if (path !== to) setStatus(`A note was already there — moved as “${displayPath(path)}”`)
			} catch (error) {
				setStatus(error instanceof Error ? error.message : String(error))
			}
			void refresh()
		},
		[actions, flush, refresh]
	)

	const removeNote = useCallback(
		async (path: string) => {
			// Deleting the open note means DISCARDING its buffer — a pending autosave
			// would write it straight back. Set the ref too: the timer reads that, and a
			// re-render is a tick away.
			if (liveRef.current.openPath && isUnder(liveRef.current.openPath, path)) {
				liveRef.current.dirty = false
				setDirty(false)
			}
			await actions.remove({ path })
			setActive(0)
			void refresh()
		},
		[actions, refresh]
	)

	// Import a drop: unzip + plan in the GUI, write in chunks through the reducer
	// (DESIGN.md §9). The vault's contents MERGE into the knowledge base root — no
	// wrapper folder — and a name that is already taken lands beside it as `… 2`.
	const importDrop = useCallback(
		async (files: File[]) => {
			if (files.length === 0) return
			try {
				setStatus('Reading…')
				const plan = await planDrop(files)
				if (plan.skipped.length > 0) console.info('[notes] import skipped', plan.skipped)
				if (plan.files.length === 0) {
					setStatus(`Nothing to import — no .md or .txt files (${plan.skipped.length} skipped)`)
					return
				}
				let written = 0
				let renamed = 0
				for (let at = 0; at < plan.files.length; at += IMPORT_CHUNK) {
					const result = await actions.importNotes({
						files: plan.files.slice(at, at + IMPORT_CHUNK)
					})
					written += result.written
					renamed += result.renamed
					setStatus(`Importing… ${written}/${plan.files.length}`)
				}
				const extra = [
					`${plan.folders} folder${plan.folders === 1 ? '' : 's'}`,
					...(plan.skipped.length > 0 ? [`${plan.skipped.length} skipped`] : []),
					...(renamed > 0 ? [`${renamed} renamed to avoid a clash`] : [])
				]
				setStatus(
					`${plan.stopped ? 'Partly imported' : 'Imported'} ${written} note${written === 1 ? '' : 's'} from ${plan.name} (${extra.join(', ')}${plan.stopped ? ' — too large, the rest was left out' : ''})`
				)
				if (!listOpen) setListOpen(true)
				void refresh()
			} catch (error) {
				setStatus(`Import failed: ${error instanceof Error ? error.message : String(error)}`)
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
	useEffect(() => {
		const onHide = () => {
			if (document.visibilityState === 'hidden') void flush()
		}
		window.addEventListener('pagehide', () => void flush())
		document.addEventListener('visibilitychange', onHide)
		return () => document.removeEventListener('visibilitychange', onHide)
	}, [flush])

	const filtered = useMemo(() => matchNotes(notes, query.trim()), [notes, query])

	const focusSearch = useCallback(() => {
		searchRef.current?.focus()
		searchRef.current?.select()
	}, [])

	// Shortcuts are scoped to the app root, not `window` — app windows share the
	// shell's document (no iframe), so a window listener would fire even when
	// another window has focus, and ⌘K must stay the shell omnibar's (DESIGN.md
	// §5). ⌘O/Ctrl+O finds a note; ⌘N is kept for hosts that deliver it (browsers
	// reserve it for a new window).
	const onRootKey = (e: React.KeyboardEvent) => {
		if (e.defaultPrevented) return
		if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
			e.preventDefault()
			focusSearch()
		} else if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
			e.preventDefault()
			void startNewNote()
		} else if (e.key === 'Escape' && e.target === editorRef.current) {
			// The nvAlt loop: Esc hops editor → search; Esc in the field hops back.
			e.preventDefault()
			focusSearch()
		}
	}

	const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'ArrowDown') {
			e.preventDefault()
			setActive((i) => Math.min(i + 1, filtered.length - 1))
		} else if (e.key === 'ArrowUp') {
			e.preventDefault()
			setActive((i) => Math.max(i - 1, 0))
		} else if (e.key === 'Enter') {
			e.preventDefault()
			const note = filtered[active]
			if (note) void openNote(note.path)
			else if (query.trim()) void createNote(query.trim(), createDir())
		} else if (e.key === 'Delete') {
			e.preventDefault()
			const note = filtered[active]
			if (note) void removeNote(note.path)
		} else if (e.key === 'Escape') {
			e.preventDefault()
			setDropOpen(false)
			editorRef.current?.focus()
		}
	}

	// The same rows serve both surfaces: the dropdown under the bar and the
	// docked pane. `data-active` (the ds-menu highlight) tracks keyboard nav
	// while the field is focused; the open note's title is just set in bold.
	const rows = (
		<>
			{filtered.map((note, i) => (
				<button
					type="button"
					key={note.path}
					className="ds-menu-item notes-item"
					data-active={searchFocused && i === active}
					data-open={note.path === openPath || undefined}
					onMouseEnter={() => setActive(i)}
					onClick={() => void openNote(note.path)}
				>
					<span className="notes-item-title">{displayPath(note.path)}</span>
					<span className="notes-item-mtime">{relativeTime(note.mtime)}</span>
				</button>
			))}
			{filtered.length === 0 ? (
				<div className="notes-empty">
					{query.trim() ? `Press Return to create “${query.trim()}”` : 'No notes yet'}
				</div>
			) : null}
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
		// biome-ignore lint/a11y/noStaticElementInteractions: the root relays app shortcuts (⌘O/⌘N/Esc) from its focusable children and accepts dropped files; tabIndex -1 keeps it out of the tab order.
		<div
			className="notes"
			onKeyDown={onRootKey}
			tabIndex={-1}
			data-file-drop={fileDrop || undefined}
			// A dropped file is an import, accepted wherever it lands — pane, editor or
			// bar. Internal row drags carry `text/plain`, not `Files`, so the tree's own
			// move-drop never reaches here (DESIGN.md §9).
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
					<button type="button" title="New note" onClick={() => void startNewNote()}>
						New
					</button>
				</div>
			) : null}
			{error ? <p className="notes-error">{error}</p> : null}
			{status ? <p className="notes-status">{status}</p> : null}
			<div className="notes-body" ref={bodyRef} data-dragging={dragging || undefined}>
				{listOpen ? (
					<div className="notes-side" style={{ width: listWidth }}>
						<div className="notes-side-head">
							{toggleButton}
							{searchField}
						</div>
						<NotesTree
							entries={entries}
							openPath={openPath}
							query={query}
							onOpen={(path) => void openNote(path)}
							onSelectDir={(dir) => {
								selectedDirRef.current = dir
							}}
							onCreate={(dir, title) => void createNote(title, dir)}
							onMkdir={(path) => void actions.mkdir({ path })}
							onRename={moveNote}
							onRemove={(path) => void removeNote(path)}
						/>
						<div className="notes-side-foot">
							<button type="button" onClick={() => void startNewNote()}>
								＋ New Note
							</button>
						</div>
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
				<textarea
					ref={editorRef}
					className="notes-editor"
					placeholder="Start typing…"
					value={text}
					onChange={(e) => {
						setText(e.target.value)
						setDirty(true)
					}}
					onBlur={() => void flush()}
					// Clicking into the editor dismisses an open dropdown (there's no backdrop).
					onMouseDown={() => {
						if (dropOpen) setDropOpen(false)
					}}
				/>
				{dropOpen && !listOpen ? <div className="ds-menu notes-results">{rows}</div> : null}
			</div>
		</div>
	)
}
