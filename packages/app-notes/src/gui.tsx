import type { GUIProps } from '@justfiles/app/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Note, NotesApp } from './app.ts'
import './style.css'

const AUTOSAVE_MS = 800
const LIST_PREF_KEY = 'app-notes:list-open'

const titleOf = (path: string) => path.slice(1, -4)
const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform)

// The host may sandbox the app iframe without `allow-same-origin`, where even
// touching localStorage throws — degrade to a per-session preference.
const readListPref = () => {
	try {
		return localStorage.getItem(LIST_PREF_KEY) === '1'
	} catch {
		return false
	}
}
const writeListPref = (open: boolean) => {
	try {
		localStorage.setItem(LIST_PREF_KEY, open ? '1' : '0')
	} catch {
		// sandboxed — the toggle still works, it just resets next launch
	}
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
	const { openPath, revision, error } = state

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
	const [notes, setNotes] = useState<Note[]>([])
	const [active, setActive] = useState(0)

	// Refs so async flushes/effects read the latest values without re-binding.
	const liveRef = useRef({ text, openPath, dirty })
	liveRef.current = { text, openPath, dirty }
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
				const settled = await actions.create({ text })
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
		document.title = openPath ? titleOf(openPath) : 'Notes'
	}, [openPath])

	// The list is never cached in reducer state (DESIGN.md §3) — re-scan /notes
	// whenever a surface that shows it appears (search focus, docked pane).
	const refresh = useCallback(async () => setNotes(await actions.list({})), [actions])

	useEffect(() => {
		if (listOpen) void refresh()
	}, [listOpen, refresh])

	const openNote = useCallback(
		async (path: string) => {
			await flush()
			setDropOpen(false)
			setQuery('')
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

	// Enter on an empty result set: the query becomes the first line of a new
	// note (the nvAlt move — search and create are one gesture).
	const createFromQuery = useCallback(
		async (title: string) => {
			await flush()
			setDropOpen(false)
			setQuery('')
			const body = `${title}\n`
			creatingRef.current = true
			try {
				const settled = await actions.create({ text: body })
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

	const removeNote = useCallback(
		async (path: string) => {
			await actions.remove({ path })
			setActive(0)
			void refresh()
		},
		[actions, refresh]
	)

	const toggleList = useCallback(() => {
		const next = !listOpen
		setListOpen(next)
		setDropOpen(false)
		writeListPref(next)
		// The search field remounts across the bar/pane move, dropping focus —
		// land it on the editor so root-scoped shortcuts keep working.
		editorRef.current?.focus()
	}, [listOpen])

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

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase()
		return q ? notes.filter((n) => n.title.toLowerCase().includes(q)) : notes
	}, [notes, query])

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
			else if (query.trim()) void createFromQuery(query.trim())
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
					<span className="notes-item-title">{note.title}</span>
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
		// biome-ignore lint/a11y/noStaticElementInteractions: the root only relays app shortcuts (⌘O/⌘N/Esc) from its focusable children; tabIndex -1 keeps it out of the tab order.
		<div className="notes" onKeyDown={onRootKey} tabIndex={-1}>
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
			<div className="notes-body">
				{listOpen ? (
					<div className="notes-side">
						<div className="notes-side-head">
							{toggleButton}
							{searchField}
						</div>
						<div className="notes-list">{rows}</div>
						<div className="notes-side-foot">
							<button type="button" onClick={() => void startNewNote()}>
								＋ New Note
							</button>
						</div>
					</div>
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
