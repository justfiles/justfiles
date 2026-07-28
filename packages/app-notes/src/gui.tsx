import type { GUIProps } from '@justfiles/app/react'
import { unzip } from 'fflate'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Entry, NotesApp } from './app.ts'
import { createScreen, type ImportPlan, planImport, type Screen } from './import.ts'
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

// Unzip only what we intend to keep. `filter` runs against the archive's central
// directory, so an entry is judged from its HEADER and never inflated — a
// picture-heavy vault, a zip bomb, or simply more notes than we will accept would
// otherwise be decompressed into the tab in full just to be thrown away. The screen
// carries the drop's running budget, which is why it is passed in rather than made
// here (see `createScreen`).
function readZip(bytes: Uint8Array, screen: Screen): Promise<Record<string, Uint8Array>> {
	return new Promise((resolve, reject) => {
		unzip(
			bytes,
			{ filter: (info) => !info.name.endsWith('/') && screen.accept(info.name, info.originalSize) },
			(error, entries) => (error ? reject(error) : resolve(entries))
		)
	})
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
	if (zip)
		return planImport(await readZip(new Uint8Array(await zip.arrayBuffer()), screen), zip.name, {
			screen
		})
	const entries: Record<string, Uint8Array> = {}
	for (const file of files) {
		// Screened from `File.size` FIRST: reading a 2 GB body into the tab only to
		// classify it as an attachment is the same mistake as inflating a zip entry.
		if (!screen.accept(file.name, file.size)) continue
		entries[file.name] = new Uint8Array(await file.arrayBuffer())
	}
	return planImport(entries, 'Imported', { screen })
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
	// whenever something was created/removed/renamed on disk (`treeRevision`).
	const refreshTokenRef = useRef(0)
	const treeSeenRef = useRef(0)
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

	// Where a new note goes: the folder selected in the tree if it is STILL THERE,
	// else beside the open note (Obsidian's "same folder as the current file"), else
	// the root. Derived at the moment of use and checked against the listing, which
	// is itself derived from disk — so a folder that was deleted or renamed simply
	// stops being a target instead of being silently recreated by `writeFile`.
	const createDir = useCallback(() => {
		const selected = selectedDirRef.current
		if (selected && entries.some((e) => e.type === 'dir' && e.path === selected)) return selected
		return parentDir(openPath ?? '/')
	}, [entries, openPath])
	liveRef.current.dir = createDir()

	useEffect(() => {
		if (!listOpen) return
		// `treeRevision` bumps once per write, and a bulk writer (an import, or the
		// agent) emits thousands — one growing full-tree scan per note would swamp the
		// app. Coalesce: each bump resets the timer, so the scan runs once the writes
		// stop. Opening the pane is not a bump, so it still lists immediately.
		if (treeSeenRef.current === treeRevision) {
			void refresh()
			return
		}
		treeSeenRef.current = treeRevision
		const id = setTimeout(() => void refresh(), REFRESH_MS)
		return () => clearTimeout(id)
	}, [listOpen, treeRevision, refresh])

	const openNote = useCallback(
		async (path: string) => {
			await flush()
			setDropOpen(false)
			setQuery('')
			// Opening a note supersedes a folder click as the "where am I" hint.
			selectedDirRef.current = null
			await actions.open({ path })
			editorRef.current?.focus()
			if (listOpen) void refresh() // the flushed note's mtime may reorder the list
		},
		[flush, actions, listOpen, refresh]
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
				const settled = await actions.create({ text: body, dir })
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
			if (listOpen) void refresh()
		},
		[flush, actions, listOpen, refresh]
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
							onRename={(from, to) => void moveNote(from, to)}
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
