import type { Client } from '@justfiles/app'
import { defineGUI } from '@justfiles/app/browser'
import type { ContextMenuItem, FileTreeBatchOperation } from '@pierre/trees'
import { FileTree as PierreFileTree, useFileTree } from '@pierre/trees/react'
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type FilesApp, type FilesState, initialState } from './app.ts'
// Plain side-effect CSS import. `vite dev` injects it; the production build folds
// it into gui.js as a runtime <style> (see the kernel-host-css plugin in
// packages/app/vite.ts), so the bundle stays self-contained in every host.
import './gui.css'

const stateOrInitial = (value: unknown): FilesState =>
	value && typeof value === 'object' && 'files' in value ? (value as FilesState) : initialState

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
// full byte length on disk (not the capped preview slice).
type Preview = { path: string; content: string; truncated: boolean; size: number }

function Files({ state, client }: { state: FilesState; client: Client<FilesApp> }) {
	// Kick a scan on first mount when we have no file list yet. The recursive watch
	// only fires on CHANGES, so a first-ever open (or a genuinely empty cache) needs
	// one initial scan to populate the tree; after that, auto-refresh keeps it live.
	// Whether a scan is in flight is the kernel's business (the scan is coalesced),
	// so there is nothing stale to neutralize here — we just ensure the list exists.
	const refreshed = useRef(false)
	useEffect(() => {
		if (refreshed.current) return
		refreshed.current = true
		if (state.files.length === 0) void client.refresh({})
	}, [client, state.files.length])

	// Re-read the file whenever `currentViewing` changes — or when `revision`
	// bumps, which the app does each time the watched file changes on disk (Part
	// D), so an external edit refreshes the preview. Content is GUI-only transient
	// state; the bytes can change underneath us and a stale cache would lie. A
	// token guards against races: late responses from a previous path are dropped
	// instead of clobbering a newer click.
	const [preview, setPreview] = useState<Preview | null>(null)
	const [readError, setReadError] = useState<string | null>(null)
	const tokenRef = useRef(0)
	const viewing = state.currentViewing
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

	const files = useMemo(() => state.files.map((file) => file.path), [state.files])
	const displayError = state.error ?? readError
	const showPreview = preview && preview.path === viewing ? preview : null

	// Draggable splitter: the sidebar width lives in GUI-only state. Pointer
	// capture keeps the drag alive even when the cursor outruns the thin handle.
	const [sidebarWidth, setSidebarWidth] = useState(224)
	const [dragging, setDragging] = useState(false)
	const drag = useRef<{ startX: number; startWidth: number } | null>(null)
	const clampWidth = (w: number) => Math.min(560, Math.max(160, w))

	return (
		<div className="files">
			<aside className="files-sidebar" style={{ width: sidebarWidth }}>
				<header className="files-head">
					<span className="files-title">Files</span>
				</header>
				{state.error ? <p className="files-error">{state.error}</p> : null}
				{files.length === 0 ? (
					<p className="files-hint">No files yet</p>
				) : (
					<div className="files-tree-wrap">
						<FilesTree
							files={files}
							selectedPath={viewing}
							onSelect={(path) => void client.setView({ path })}
							onDelete={(path) => void client.remove({ path })}
						/>
					</div>
				)}
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
							{displayError ? (
								<span style={{ color: '#b91c1c' }}>{displayError}</span>
							) : showPreview ? (
								<>
									{showPreview.content}
									{showPreview.truncated ? (
										<span className="files-truncated">… preview truncated</span>
									) : null}
								</>
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

// Canonical ancestor directory paths of a file, shallowest first, each with a
// trailing slash: `a/b/c.ts` → [`a/`, `a/b/`]. Root-level files have none.
function ancestorDirs(path: string): string[] {
	const dirs: string[] = []
	for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1))
		dirs.push(path.slice(0, i + 1))
	return dirs
}

// Parent of a canonical directory path (`a/b/` → `a/`; `a/` → ``).
function parentDir(dir: string): string {
	const cut = dir.lastIndexOf('/', dir.length - 2)
	return cut === -1 ? '' : dir.slice(0, cut + 1)
}

// Reconcile the tree from the `prev` file-path set to `next` using the
// incremental mutation API instead of a whole-tree `resetPaths`. This preserves
// expansion + selection (a coarse reset re-applies `initialExpansion: 'open'`)
// and only rebuilds touched nodes, so it is also cheaper on large trees. The
// tree derives directories from file paths: `add` recreates missing ancestors,
// but `remove` leaves an emptied ancestor behind as an explicit row — so prune
// the shallowest now-stale dir per branch (a recursive remove takes the rest).
function applyPathDiff(model: FileTreeModel, prev: string[], next: string[]): void {
	const prevSet = new Set(prev)
	const nextSet = new Set(next)
	const added = next.filter((path) => !prevSet.has(path))
	const removed = prev.filter((path) => !nextSet.has(path))
	if (added.length === 0 && removed.length === 0) return

	// Directories still backed by a file in `next`; any removed-file ancestor
	// missing from this set is now empty and must go.
	const neededDirs = new Set<string>()
	for (const file of next) for (const dir of ancestorDirs(file)) neededDirs.add(dir)
	const staleDirs = new Set<string>()
	for (const file of removed)
		for (const dir of ancestorDirs(file)) if (!neededDirs.has(dir)) staleDirs.add(dir)
	const removeDirs = [...staleDirs].filter((dir) => !staleDirs.has(parentDir(dir)))

	const ops: FileTreeBatchOperation[] = []
	for (const dir of removeDirs) ops.push({ type: 'remove', path: dir, recursive: true })
	for (const file of removed)
		if (!removeDirs.some((dir) => file.startsWith(dir))) ops.push({ type: 'remove', path: file })
	for (const file of added) ops.push({ type: 'add', path: file })
	model.batch(ops)
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
	files: string[]
	selectedPath: string | null
	onSelect: (path: string) => void
	onDelete: (path: string) => void
}) {
	const latest = useRef(props)
	latest.current = props
	// State reaches this GUI across a structured-clone boundary (the host pushes it
	// via postMessage — see apps/frieren gui-channel.ts), so `props.files` is a
	// FRESH array on every push, even a plain selection that changes nothing about
	// the file set. Key `paths` on the SET's value, not the array identity, so the
	// reconcile effect below fires only when files are truly added/removed — never
	// on a selection — and expansion state is left untouched in the common case.
	const pathsKey = props.files.join('\n')
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional — recompute only when the path set changes by value (pathsKey), not on every structured-clone push (see above).
	const paths = useMemo(() => props.files.map(stripSlash), [pathsKey])
	const selectedPath = props.selectedPath ? stripSlash(props.selectedPath) : null

	const { model } = useFileTree({
		paths,
		flattenEmptyDirectories: true,
		initialExpansion: 'open',
		initialSelectedPaths: selectedPath ? [selectedPath] : [],
		itemHeight: 24,
		density: 0.85,
		onSelectionChange: (selected) => {
			const { files, onSelect } = latest.current
			const path = selected.find((candidate) => files.includes(`/${candidate}`))
			if (path) onSelect(`/${path}`)
		}
	})

	// The model is created (by useFileTree) with the initial `paths`; seed `prev`
	// to null so the first run is a no-op, then reconcile each later set change
	// incrementally instead of rebuilding the whole tree.
	const prevPaths = useRef<string[] | null>(null)
	useEffect(() => {
		const prev = prevPaths.current
		prevPaths.current = paths
		if (prev) applyPathDiff(model, prev, paths)
	}, [model, paths])

	useEffect(() => {
		if (!selectedPath) return
		const item = model.getItem(selectedPath)
		if (!item) return
		const selected = model.getSelectedPaths()
		if (selected.length !== 1 || selected[0] !== selectedPath) {
			for (const path of selected) model.getItem(path)?.deselect()
			item.select()
		}
		model.scrollToPath(selectedPath, { focus: false })
	}, [model, selectedPath])

	return (
		<PierreFileTree
			model={model}
			className="files-tree"
			renderContextMenu={(item: ContextMenuItem, context) => {
				// The tree runs on slash-stripped paths and marks directories with a
				// trailing slash (`folder/`); restore the leading slash and drop any
				// trailing one so `volume.rm` resolves the entry itself — a trailing
				// slash makes it clear the folder's contents but leave the folder behind.
				const path = `/${item.path}`.replace(/\/+$/, '')
				return (
					<DeleteMenu
						// Key on the target so re-aiming the menu at another row (right-click
						// without dismissing first) remounts it, resetting the arm-to-confirm
						// state instead of inheriting a primed click for the new target.
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
	)
}
