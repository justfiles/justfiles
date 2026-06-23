import type { Client } from '@justfiles/app'
import { defineGUI } from '@justfiles/app/browser'
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
				{state.loading ? (
					<p className="files-hint">Loading…</p>
				) : files.length === 0 ? (
					<p className="files-hint">No files yet</p>
				) : (
					<div className="files-tree-wrap">
						<FilesTree
							files={files}
							selectedPath={viewing}
							onSelect={(path) => void client.setView({ path })}
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

function FilesTree(props: {
	files: string[]
	selectedPath: string | null
	onSelect: (path: string) => void
}) {
	const latest = useRef(props)
	latest.current = props
	const paths = useMemo(() => props.files.map(stripSlash), [props.files])
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

	useEffect(() => {
		model.resetPaths(paths)
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

	return <PierreFileTree model={model} className="files-tree" />
}
