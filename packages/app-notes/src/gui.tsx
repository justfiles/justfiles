import { injectStyle } from '@justfiles/app/browser'
import type { GUIMenu, GUIProps } from '@justfiles/app/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Note, NotesApp } from './app.ts'

// Layout only — colours, controls, and the palette rows lean on the platform
// sheet (`@justfiles/design/mac`) and its tokens, so the app reads as native and
// gets dark mode for free (DESIGN.md §5). The editor is a full-bleed `<textarea>`
// with its native chrome stripped; the palette rows reuse `.ds-menu` /
// `.ds-menu-item`, which already carry the macOS selection highlight.
injectStyle(
	`
.notes { display: flex; flex-direction: column; height: 100%; width: 100%; background: var(--window-bg); color: var(--text); }
.notes-error { flex: none; padding: 4px 12px; font-size: 12px; color: #b91c1c; }
/* Search bar: a top strip in normal flow, so opening it pushes the editor down
   onto the same surface (no overlay). Only the results list floats (below). */
.notes-search { flex: none; padding: 6px 10px; border-bottom: 1px solid var(--rule); background: var(--surface); }
.notes-search input { width: 100%; box-sizing: border-box; }
.notes-body { position: relative; flex: 1; min-height: 0; display: flex; }
.notes-editor { flex: 1; min-height: 0; width: 100%; box-sizing: border-box; resize: none; border: 0; outline: none; box-shadow: none; background: transparent; color: inherit; padding: 16px 18px; font-family: var(--font-ui); font-size: 14px; line-height: 1.5; }
/* The candidate list is the ONLY thing that overlays the editor — a dropdown
   anchored under the search bar (top of the editor body). */
.notes-results { position: absolute; top: 0; left: 0; right: 0; z-index: 10; max-height: min(60%, 360px); overflow-y: auto; border-radius: 0 0 var(--menu-radius) var(--menu-radius); }
.notes-palette-item { justify-content: space-between; gap: 12px; }
.notes-palette-mtime { font-size: 11px; opacity: 0.5; }
.notes-palette-item[data-active="true"] .notes-palette-mtime { opacity: 0.8; }
.notes-palette-empty { padding: 8px 18px; font-size: 12px; opacity: 0.5; }
`,
	'app-notes'
)

const AUTOSAVE_MS = 800

const titleOf = (path: string) => path.slice(1, -4)

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

	// The Cmd+K palette — re-fetched on every open, so it never shows a stale set.
	const [paletteOpen, setPaletteOpen] = useState(false)
	const [query, setQuery] = useState('')
	const [notes, setNotes] = useState<Note[]>([])
	const [active, setActive] = useState(0)

	// Refs so async flushes/effects read the latest values without re-binding.
	const liveRef = useRef({ text, openPath, dirty })
	liveRef.current = { text, openPath, dirty }
	const loadedRef = useRef<string | null>(null) // path whose body is in the buffer
	const justCreatedRef = useRef<string | null>(null) // skip the reload right after a local create
	const pendingPathRef = useRef<string | null>(null) // created path before the state push catches up
	const creatingRef = useRef(false)
	const readTokenRef = useRef(0)
	const editorRef = useRef<HTMLTextAreaElement>(null)

	// Persist the dirty buffer. Correctness comes from flush-if-dirty on every
	// transition (switch, Cmd+N, blur, close); the debounce is only a perf win
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
					justCreatedRef.current = settled.openPath
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
		if (justCreatedRef.current === openPath) {
			justCreatedRef.current = null
			loadedRef.current = openPath
			return
		}
		// A `revision` bump from our OWN autosave (writeFile re-fires the watch) must
		// not clobber edits typed since the flush — only reload disk when not dirty.
		if (loadedRef.current === openPath && liveRef.current.dirty) return
		const token = ++readTokenRef.current
		void actions.readNote({ path: openPath }).then((result) => {
			if (readTokenRef.current !== token) return
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
	}, [openPath, actions])

	// Keep focus on the editor whenever the palette is closed — on launch and after
	// every dismiss path (Esc, click-away, selecting a note), so typing resumes at once.
	useEffect(() => {
		if (!paletteOpen) editorRef.current?.focus()
	}, [paletteOpen])

	// Reflect the open note's filename as the document title — hosts with a native
	// title bar (e.g. desktop) show it there; in quay the centered header below is
	// the visible title (the native title is hidden behind a transparent titlebar).
	useEffect(() => {
		document.title = openPath ? titleOf(openPath) : 'Notes'
	}, [openPath])

	const openPalette = useCallback(async () => {
		setActive(0)
		setQuery('')
		setPaletteOpen(true)
		setNotes(await actions.list({}))
	}, [actions])

	const openNote = useCallback(
		async (path: string) => {
			await flush()
			setPaletteOpen(false)
			await actions.open({ path })
		},
		[flush, actions]
	)

	const startNewNote = useCallback(async () => {
		await flush()
		setPaletteOpen(false)
		// Clear the buffer directly: when already on a blank note (openPath null),
		// newNote() doesn't change openPath, so the read effect won't fire — without
		// this, Cmd+N on a fresh note would be a no-op.
		setText('')
		setDirty(false)
		pendingPathRef.current = null
		loadedRef.current = null
		await actions.newNote({})
	}, [flush, actions])

	const removeNote = useCallback(
		async (path: string) => {
			await actions.remove({ path })
			setNotes(await actions.list({}))
			setActive(0)
		},
		[actions]
	)

	// Global shortcuts (DESIGN.md §5). Cmd+K won't clash — a plain-text editor has
	// no insert-link — and Cmd+P stays free for printing.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
				e.preventDefault()
				void openPalette()
			} else if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
				e.preventDefault()
				void startNewNote()
			} else if (e.key === 'Escape' && paletteOpen) {
				e.preventDefault()
				setPaletteOpen(false)
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [openPalette, startNewNote, paletteOpen])

	// Bridge the File menu (a separate render surface) to the flush-aware handlers.
	useEffect(() => {
		const onNew = () => void startNewNote()
		const onOpen = () => void openPalette()
		window.addEventListener('app-notes:new', onNew)
		window.addEventListener('app-notes:open', onOpen)
		return () => {
			window.removeEventListener('app-notes:new', onNew)
			window.removeEventListener('app-notes:open', onOpen)
		}
	}, [startNewNote, openPalette])

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

	const onPaletteKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
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
		} else if (e.key === 'Delete') {
			e.preventDefault()
			const note = filtered[active]
			if (note) void removeNote(note.path)
		}
	}

	return (
		<div className="notes">
			{/* The note's filename shows in the native window titlebar (document.title,
			    set above) — no in-app title bar, so the editor is full-bleed. */}
			{paletteOpen ? (
				<div className="notes-search">
					<input
						// biome-ignore lint/a11y/noAutofocus: a search palette focuses its filter on open by design.
						autoFocus
						placeholder="Search notes…"
						value={query}
						onChange={(e) => {
							setQuery(e.target.value)
							setActive(0)
						}}
						onKeyDown={onPaletteKey}
					/>
				</div>
			) : null}
			{error ? <p className="notes-error">{error}</p> : null}
			<div className="notes-body">
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
					// Clicking into the editor dismisses an open search (there's no backdrop).
					onMouseDown={() => {
						if (paletteOpen) setPaletteOpen(false)
					}}
				/>
				{paletteOpen ? (
					<div className="ds-menu notes-results">
						{filtered.length === 0 ? (
							<div className="notes-palette-empty">No notes</div>
						) : (
							filtered.map((note, i) => (
								<button
									type="button"
									key={note.path}
									className="ds-menu-item notes-palette-item"
									data-active={i === active}
									onMouseEnter={() => setActive(i)}
									onClick={() => void openNote(note.path)}
								>
									<span>{note.title}</span>
									<span className="notes-palette-mtime">{relativeTime(note.mtime)}</span>
								</button>
							))
						)}
					</div>
				) : null}
			</div>
		</div>
	)
}

// Optional File menu (DESIGN.md §5). Items route through window events to the
// component's flush-aware handlers, so a menu click saves before it transitions.
export const menu: GUIMenu<NotesApp> = () => [
	{
		title: 'File',
		items: [
			{
				title: 'New Note',
				shortcut: '⌘N',
				onSelect: () => window.dispatchEvent(new Event('app-notes:new'))
			},
			{
				title: 'Open…',
				shortcut: '⌘K',
				onSelect: () => window.dispatchEvent(new Event('app-notes:open'))
			}
		]
	}
]
