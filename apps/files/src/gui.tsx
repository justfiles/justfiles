import type { Client } from '@justfiles/app'
import { defineGUI } from '@justfiles/app/browser'
import type { ContextMenuItem, FileTreeBatchOperation } from '@pierre/trees'
import { FileTree as PierreFileTree, useFileTree } from '@pierre/trees/react'
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
	type DirectoryResult,
	type FilesApp,
	type FilesState,
	initialState,
	isUserFacing
} from './app.ts'
import { diffChildren, expandedDirectories, isDirectory, type TreeEntry } from './tree.ts'
// Plain side-effect CSS import. `vite dev` injects it; the production build folds
// it into gui.js as a runtime <style> (see the kernel-host-css plugin in
// packages/app/vite.ts), so the bundle stays self-contained in every host.
import './gui.css'

const stateOrInitial = (value: unknown): FilesState => {
	if (!value || typeof value !== 'object') return initialState
	const state = value as Partial<FilesState>
	return {
		currentViewing: typeof state.currentViewing === 'string' ? state.currentViewing : null,
		revision: typeof state.revision === 'number' ? state.revision : 0,
		treeRevision: typeof state.treeRevision === 'number' ? state.treeRevision : 0,
		showHidden: state.showHidden === true
	}
}

export const gui = defineGUI<FilesApp>({
	mount(el, state, ctx) {
		const root = createRoot(el)
		const render = (next: FilesState | null) =>
			root.render(
				<StrictMode>
					<Files state={stateOrInitial(next)} client={ctx.client} />
				</StrictMode>
			)
		render(state)
		return {
			update: render,
			unmount() {
				root.unmount()
			}
		}
	}
})

function basename(path: string): string {
	const parts = path.split('/').filter(Boolean)
	return parts[parts.length - 1] ?? path
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']
function formatSize(bytes: number): string {
	let size = bytes
	let unit = 0
	while (size >= 1024 && unit < SIZE_UNITS.length - 1) {
		size /= 1024
		unit++
	}
	// Whole bytes; one decimal under 10 of a larger unit (2.5 KB), else rounded.
	const value = unit === 0 || size >= 10 ? Math.round(size) : Math.round(size * 10) / 10
	return `${value} ${SIZE_UNITS[unit]}`
}

// Preview shape returned by the `readFile` query. Kept local to the GUI —
// content lives in React state only, never in app state. `size` is the file's
// full byte length on disk (not the capped preview slice). Images carry a data
// URL (`dataUrl` null when the file is too large to inline) instead of text.
type Preview =
	| { path: string; kind: 'text'; content: string; truncated: boolean; size: number }
	| { path: string; kind: 'image'; dataUrl: string | null; truncated: boolean; size: number }

function Files({ state, client }: { state: FilesState; client: Client<FilesApp> }) {
	// Re-read the file whenever `currentViewing` changes — or when `revision`
	// bumps, which the app does each time the watched file changes on disk (Part
	// D), so an external edit refreshes the preview. Content is GUI-only transient
	// state; the bytes can change underneath us and a stale cache would lie. A
	// token guards against races: late responses from a previous path are dropped
	// instead of clobbering a newer click.
	const [preview, setPreview] = useState<Preview | null>(null)
	const [readError, setReadError] = useState<string | null>(null)
	const tokenRef = useRef(0)
	// Only preview a file that is actually visible in the current mode. A selection
	// the whitelist hides — a persisted `currentViewing` under /system, or a file
	// picked in "All files" mode before ⌘⇧. was toggled back off — must not stay
	// open in the preview. Deriving `viewing` (rather than clearing state) keeps
	// the selection intact, so toggling ⌘⇧. back on re-reveals it.
	const viewing =
		state.currentViewing && (state.showHidden || isUserFacing(state.currentViewing))
			? state.currentViewing
			: null
	const revision = state.revision
	// biome-ignore lint/correctness/useExhaustiveDependencies: revision is a cache-busting trigger — a bump means the watched file changed on disk, so re-run the read even though the body doesn't read it.
	useEffect(() => {
		if (!viewing) {
			setPreview(null)
			setReadError(null)
			return
		}
		const token = ++tokenRef.current
		setReadError(null)
		void client
			.readFile({ path: viewing })
			.then((result) => {
				if (tokenRef.current !== token) return
				setPreview(result)
			})
			.catch((err) => {
				if (tokenRef.current !== token) return
				setPreview(null)
				setReadError(err instanceof Error ? err.message : String(err))
			})
	}, [client, viewing, revision])

	const showHidden = state.showHidden ?? false
	const showPreview = preview && preview.path === viewing ? preview : null

	// Draggable splitter: the sidebar width lives in GUI-only state. Pointer
	// capture keeps the drag alive even when the cursor outruns the thin handle.
	const [sidebarWidth, setSidebarWidth] = useState(224)
	const [dragging, setDragging] = useState(false)
	const drag = useRef<{ startX: number; startWidth: number } | null>(null)
	const clampWidth = (w: number) => Math.min(560, Math.max(160, w))

	// ⌘⇧. (Ctrl⇧. off-mac) toggles "show all files", exactly like macOS Finder's
	// hidden-files shortcut. Scoped to the app root (not `window`) so it never
	// clobbers another focused window's keys in a shared-document host, and so it
	// only fires while Files has focus. Shift rewrites '.' to '>' on most layouts,
	// so match the physical key via `code` and tolerate both `key` values.
	const onRootKey = (e: React.KeyboardEvent) => {
		if (e.defaultPrevented) return
		if (
			(e.metaKey || e.ctrlKey) &&
			e.shiftKey &&
			(e.code === 'Period' || e.key === '.' || e.key === '>')
		) {
			e.preventDefault()
			void client.toggleHidden({})
		}
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the root only relays the app's ⌘⇧. shortcut from its focusable children; tabIndex -1 keeps it out of the tab order.
		<div className="files" onKeyDown={onRootKey} tabIndex={-1}>
			<aside className="files-sidebar" style={{ width: sidebarWidth }}>
				<header className="files-head">
					<span className="files-title">Files</span>
					{showHidden ? <span className="files-mode">All files</span> : null}
				</header>
				<div className="files-tree-wrap">
					<FilesTree
						client={client}
						revision={state.treeRevision}
						showHidden={showHidden}
						selectedPath={viewing}
						onSelect={(path) => void client.setView({ path })}
						onClear={() => void client.clear({})}
						onDelete={(path) => void client.remove({ path })}
					/>
				</div>
			</aside>
			<button
				type="button"
				className={dragging ? 'files-resizer dragging' : 'files-resizer'}
				aria-label="Resize sidebar"
				onPointerDown={(e) => {
					drag.current = { startX: e.clientX, startWidth: sidebarWidth }
					setDragging(true)
					e.currentTarget.setPointerCapture(e.pointerId)
				}}
				onPointerMove={(e) => {
					if (!drag.current) return
					setSidebarWidth(clampWidth(drag.current.startWidth + (e.clientX - drag.current.startX)))
				}}
				onPointerUp={(e) => {
					drag.current = null
					setDragging(false)
					e.currentTarget.releasePointerCapture(e.pointerId)
				}}
				onKeyDown={(e) => {
					if (e.key === 'ArrowLeft') setSidebarWidth((w) => clampWidth(w - 16))
					else if (e.key === 'ArrowRight') setSidebarWidth((w) => clampWidth(w + 16))
				}}
			/>
			<section className="files-main">
				{viewing ? (
					<>
						<header className="files-main-head">
							<span className="files-main-name">{basename(viewing)}</span>
							<div className="files-meta">
								<span className="files-path" title={viewing}>
									{viewing}
								</span>
								{showPreview ? (
									<span className="files-size">{formatSize(showPreview.size)}</span>
								) : null}
							</div>
						</header>
						<pre className="files-preview">
							{readError ? (
								<span style={{ color: 'var(--danger)' }}>{readError}</span>
							) : showPreview ? (
								showPreview.kind === 'image' ? (
									showPreview.dataUrl ? (
										<img
											className="files-image"
											src={showPreview.dataUrl}
											alt={basename(viewing)}
										/>
									) : (
										<span className="files-muted">Image too large to preview</span>
									)
								) : (
									<>
										{showPreview.content}
										{showPreview.truncated ? (
											<span className="files-truncated">… preview truncated</span>
										) : null}
									</>
								)
							) : (
								<span className="files-muted">Loading…</span>
							)}
						</pre>
					</>
				) : (
					<div className="files-empty">Select a file to preview</div>
				)}
			</section>
		</div>
	)
}

// The volume reports absolute paths (`/src/app.ts`); `@pierre/trees` treats a
// leading slash as an empty first segment, so feed it slash-stripped paths and
// re-add the slash when a selection comes back.
const stripSlash = (path: string) => path.replace(/^\/+/, '')

type FileTreeModel = ReturnType<typeof useFileTree>['model']

function volumePath(path: string): string {
	return `/${path}`.replace(/\/+$/, '') || '/'
}

function parentDirectory(path: string): string {
	const cut = path.lastIndexOf('/')
	return cut <= 0 ? '/' : path.slice(0, cut)
}

function shownEntries(
	parent: string,
	entries: readonly TreeEntry[],
	showHidden: boolean
): TreeEntry[] {
	return entries.filter((entry) => {
		if (entry.type === 2) return false
		if (parent !== '/' || showHidden) return true
		return isUserFacing(`/${entry.name}`)
	})
}

// The right-click menu reuses the shared `ds-menu` component (design.css, cloned
// into the app frame by the host — same classes the OS desktop menu and menubar
// use). `@pierre/trees` slots it into a cursor-anchored, fixed-position element,
// so `position: absolute` floats the box out from that origin. Delete is guarded
// by a second click — the GUI iframe has no `allow-modals`, so `confirm()` is a
// no-op, and a hard delete (no trash) warrants one deliberate re-click.
function DeleteMenu(props: { label: string; onDelete: () => void }) {
	const [armed, setArmed] = useState(false)
	return (
		<div className="ds-menu" role="menu" style={{ position: 'absolute', top: 0, left: 0 }}>
			<button
				type="button"
				className="ds-menu-item"
				role="menuitem"
				onClick={() => (armed ? props.onDelete() : setArmed(true))}
			>
				{armed ? 'Click again to confirm' : props.label}
			</button>
		</div>
	)
}

function FilesTree(props: {
	client: Client<FilesApp>
	revision: number
	showHidden: boolean
	selectedPath: string | null
	onSelect: (path: string) => void
	onClear: () => void
	onDelete: (path: string) => void
}) {
	const latest = useRef(props)
	latest.current = props
	const selectedPath = props.selectedPath ? stripSlash(props.selectedPath) : null
	const revision = props.revision
	const modelRef = useRef<FileTreeModel | null>(null)

	const { model } = useFileTree({
		paths: [],
		flattenEmptyDirectories: true,
		initialExpansion: 'closed',
		itemHeight: 24,
		density: 0.85,
		onSelectionChange: (selected) => {
			const path = selected.find(
				(candidate) => modelRef.current?.getItem(candidate)?.isDirectory() === false
			)
			if (path) latest.current.onSelect(volumePath(path))
		}
	})
	modelRef.current = model

	const snapshots = useRef(new Map<string, TreeEntry[]>())
	const shown = useRef(new Map<string, TreeEntry[]>())
	const expanded = useRef(new Set<string>())
	const tokens = useRef(new Map<string, number>())
	const alive = useRef(true)
	const load = useRef<(paths: string[]) => Promise<void>>(async () => {})
	const [ready, setReady] = useState(false)
	const [rootCount, setRootCount] = useState(0)
	const [treeError, setTreeError] = useState<string | null>(null)

	const selectCurrent = useCallback(() => {
		const path = latest.current.selectedPath
		if (!path) return
		const item = model.getItem(stripSlash(path))
		if (!item || item.isDirectory()) return
		const selected = model.getSelectedPaths()
		if (selected.length === 1 && selected[0] === item.getPath()) return
		for (const selectedPath of selected) model.getItem(selectedPath)?.deselect()
		item.select()
	}, [model])

	load.current = async (requested) => {
		const paths = [...new Set(requested)]
		const requestTokens = new Map<string, number>()
		for (const path of paths) {
			const token = (tokens.current.get(path) ?? 0) + 1
			tokens.current.set(path, token)
			requestTokens.set(path, token)
		}

		let results: DirectoryResult[]
		try {
			results = await latest.current.client.listDirectories({ paths })
		} catch (error) {
			if (alive.current) setTreeError(error instanceof Error ? error.message : String(error))
			return
		}
		if (!alive.current) return

		const operations: FileTreeBatchOperation[] = []
		const removedDirectories: string[] = []
		const errors: string[] = []
		results.sort((left, right) => left.path.split('/').length - right.path.split('/').length)

		for (const result of results) {
			if (tokens.current.get(result.path) !== requestTokens.get(result.path)) continue
			const directoryPath = result.path === '/' ? '' : `${stripSlash(result.path)}/`
			if (removedDirectories.some((path) => directoryPath.startsWith(path))) continue

			if (!('entries' in result)) {
				errors.push(result.error)
				if (
					result.error.includes('ENOENT') &&
					latest.current.selectedPath &&
					(latest.current.selectedPath === result.path ||
						latest.current.selectedPath.startsWith(`${result.path}/`))
				)
					latest.current.onClear()
				if (result.path === '/') setReady(true)
				continue
			}

			const entries = result.entries.filter((entry) => entry.type !== 2)
			const next = shownEntries(result.path, entries, latest.current.showHidden)
			const changes = diffChildren(result.path, shown.current.get(result.path) ?? [], next)
			for (const change of changes) {
				operations.push(change)
				if (change.type === 'remove' && change.recursive) removedDirectories.push(change.path)
			}
			snapshots.current.set(result.path, entries)
			shown.current.set(result.path, next)

			const selected = latest.current.selectedPath
			const moved = changes.find(
				(change) => change.type === 'move' && volumePath(change.from) === selected
			)
			if (moved?.type === 'move') latest.current.onSelect(volumePath(moved.to))
			else if (
				selected &&
				changes.some(
					(change) =>
						change.type === 'remove' &&
						change.recursive &&
						selected.startsWith(`${volumePath(change.path)}/`)
				)
			)
				latest.current.onClear()
			else if (
				selected &&
				parentDirectory(selected) === result.path &&
				!entries.some((entry) => entry.name === basename(selected))
			)
				latest.current.onClear()

			if (result.path === '/') {
				setRootCount(next.length)
				setReady(true)
			}
		}

		for (const path of removedDirectories) {
			const directory = volumePath(path)
			for (const loadedPath of shown.current.keys())
				if (loadedPath === directory || loadedPath.startsWith(`${directory}/`))
					shown.current.delete(loadedPath)
		}
		if (operations.length > 0) model.batch(operations)
		selectCurrent()
		setTreeError(errors[0] ?? null)
	}

	useEffect(() => {
		alive.current = true
		return () => {
			alive.current = false
		}
	}, [])

	useEffect(
		() =>
			model.subscribe(() => {
				const next = expandedDirectories(model)
				const opened = [...next].filter((path) => !expanded.current.has(path))
				expanded.current = next
				const roots = opened.filter(
					(path) => !opened.some((parent) => parent !== path && path.startsWith(parent))
				)
				if (roots.length === 0) return
				queueMicrotask(() => {
					if (!alive.current) return
					const stillOpen = roots.filter((path) => {
						const item = model.getItem(path)
						return isDirectory(item) && item.isExpanded()
					})
					const operations: FileTreeBatchOperation[] = []
					for (const path of stillOpen) {
						const directory = volumePath(path)
						operations.push(...diffChildren(directory, shown.current.get(directory) ?? [], []))
						for (const loadedPath of shown.current.keys())
							if (loadedPath === directory || loadedPath.startsWith(`${directory}/`))
								shown.current.delete(loadedPath)
					}
					if (operations.length > 0) model.batch(operations)
					if (stillOpen.length > 0) void load.current(stillOpen.map(volumePath))
				})
			}),
		[model]
	)

	useEffect(() => {
		void revision
		// Do not seed the tree from the persisted selection. Pierre fills in missing
		// ancestors for a deep path, which would make that one path look loaded.
		const paths = ['/', ...[...expanded.current].map(volumePath)]
		void load.current(paths)
	}, [revision])

	useEffect(() => {
		const entries = snapshots.current.get('/')
		if (!entries) return
		const next = shownEntries('/', entries, props.showHidden)
		const operations = diffChildren('/', shown.current.get('/') ?? [], next)
		shown.current.set('/', next)
		for (const operation of operations) {
			if (operation.type !== 'remove' || !operation.recursive) continue
			const directory = volumePath(operation.path)
			for (const path of shown.current.keys())
				if (path === directory || path.startsWith(`${directory}/`)) shown.current.delete(path)
		}
		setRootCount(next.length)
		if (operations.length > 0) model.batch(operations)
		selectCurrent()
	}, [model, props.showHidden, selectCurrent])

	useEffect(() => {
		selectCurrent()
		if (selectedPath && model.getItem(selectedPath))
			model.scrollToPath(selectedPath, { focus: false })
	}, [model, selectedPath, selectCurrent])

	return (
		<>
			{treeError ? <p className="files-error">{treeError}</p> : null}
			{!ready ? (
				<p className="files-hint">Loading…</p>
			) : rootCount === 0 ? (
				<p className="files-hint">
					{props.showHidden ? 'No files yet' : 'No files yet — ⌘⇧. shows all'}
				</p>
			) : (
				<PierreFileTree
					model={model}
					className="files-tree"
					renderContextMenu={(item: ContextMenuItem, context) => {
						const path = volumePath(item.path)
						return (
							<DeleteMenu
								key={item.path}
								label={`Delete ${item.kind === 'directory' ? 'folder' : 'file'}`}
								onDelete={() => {
									latest.current.onDelete(path)
									context.close()
								}}
							/>
						)
					}}
				/>
			)}
		</>
	)
}
