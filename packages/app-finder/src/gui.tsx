import type { Client } from '@justfiles/app'
import { defineGUI, injectStyle } from '@justfiles/app/browser'
import { FileTree as PierreFileTree, useFileTree } from '@pierre/trees/react'
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type FinderApp, type FinderState, initialState } from './app.ts'

// The app's own layout, scoped under `.finder` and injected on import. Colours come
// from the platform tokens (`--surface`, `--rule`, `--focus`); the platform sheet
// (`@justfiles/design/mac`) handles native control defaults, which the rows override.
injectStyle(
	`
.finder { display: flex; height: 100%; width: 100%; }
.finder-sidebar { display: flex; flex-direction: column; flex: none; width: 224px; overflow: hidden; background: var(--surface); border-right: 1px solid var(--rule); }
.finder-head { display: flex; flex: none; align-items: center; gap: 8px; padding: 6px 12px; }
.finder-main-head { display: flex; flex: none; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--rule); }
.finder-title, .finder-main-name { font-weight: 500; }
.finder-push { margin-left: auto; }
.finder-path { margin-left: auto; font-size: 11px; opacity: 0.5; }
.finder-main-name, .finder-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.finder-btn { flex: none; padding: 1px 8px; font-size: 11px; }
.finder-error { padding: 0 12px 8px; font-size: 12px; color: #b91c1c; }
.finder-hint { padding: 4px 12px; font-size: 12px; opacity: 0.6; }
.finder-tree-wrap { flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
.finder-tree { display: block; height: 100%; width: 100%;
	--trees-bg-override: var(--surface);
	--trees-fg-override: var(--text);
	--trees-fg-muted-override: color-mix(in srgb, var(--text) 55%, transparent);
	--trees-bg-muted-override: color-mix(in srgb, var(--text) 7%, transparent);
	--trees-border-color-override: var(--rule);
	--trees-selected-bg-override: var(--focus);
	--trees-selected-fg-override: var(--on-focus);
	--trees-focus-ring-color-override: var(--focus);
	--trees-font-family-override: ui-monospace, Menlo, monospace;
	--trees-font-size-override: 12px;
	--trees-padding-inline-override: 6px; }
.finder-main { display: flex; flex-direction: column; flex: 1; min-width: 0; background: var(--window-bg); color: var(--text); }
.finder-preview { flex: 1; min-height: 0; margin: 0; overflow: auto; padding: 12px; background: transparent; color: inherit; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, Menlo, monospace; font-size: 12px; line-height: 1.45; }
.finder-truncated { display: block; padding-top: 8px; opacity: 0.5; }
.finder-muted { opacity: 0.5; }
.finder-empty { display: flex; height: 100%; align-items: center; justify-content: center; font-size: 12px; opacity: 0.5; }
`,
	'app-finder'
)

const stateOrInitial = (value: unknown): FinderState =>
	value && typeof value === 'object' && 'files' in value ? (value as FinderState) : initialState

export const gui = defineGUI<FinderApp>({
	mount(el, state, ctx) {
		const root = createRoot(el)
		const render = (next: FinderState | null) =>
			root.render(
				<StrictMode>
					<Finder state={stateOrInitial(next)} client={ctx.client} />
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

// Preview shape returned by the `readFile` query. Kept local to the GUI —
// content lives in React state only, never in app state.
type Preview = { path: string; content: string; truncated: boolean }

function Finder({ state, client }: { state: FinderState; client: Client<FinderApp> }) {
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

	return (
		<div className="finder">
			<aside className="finder-sidebar">
				<header className="finder-head">
					<span className="finder-title">Files</span>
					<button
						type="button"
						onClick={() => void client.refresh({})}
						className="finder-btn finder-push"
					>
						Refresh
					</button>
				</header>
				{state.error ? <p className="finder-error">{state.error}</p> : null}
				{state.loading ? (
					<p className="finder-hint">Loading…</p>
				) : files.length === 0 ? (
					<p className="finder-hint">No files yet</p>
				) : (
					<div className="finder-tree-wrap">
						<FinderFileTree
							files={files}
							selectedPath={viewing}
							onSelect={(path) => void client.setView({ path })}
						/>
					</div>
				)}
			</aside>
			<section className="finder-main">
				{viewing ? (
					<>
						<header className="finder-main-head">
							<span className="finder-main-name">{basename(viewing)}</span>
							<span className="finder-path">{viewing}</span>
							<button type="button" onClick={() => void client.clear({})} className="finder-btn">
								Clear
							</button>
						</header>
						<pre className="finder-preview">
							{displayError ? (
								<span style={{ color: '#b91c1c' }}>{displayError}</span>
							) : showPreview ? (
								<>
									{showPreview.content}
									{showPreview.truncated ? (
										<span className="finder-truncated">… preview truncated</span>
									) : null}
								</>
							) : (
								<span className="finder-muted">Loading…</span>
							)}
						</pre>
					</>
				) : (
					<div className="finder-empty">Select a file to preview</div>
				)}
			</section>
		</div>
	)
}

// The volume reports absolute paths (`/src/app.ts`); `@pierre/trees` treats a
// leading slash as an empty first segment, so feed it slash-stripped paths and
// re-add the slash when a selection comes back.
const stripSlash = (path: string) => path.replace(/^\/+/, '')

function FinderFileTree(props: {
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

	return <PierreFileTree model={model} className="finder-tree" />
}
