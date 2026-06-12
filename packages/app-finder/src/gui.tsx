import type { Client } from '@justfiles/app'
import { defineGUI, injectStyle } from '@justfiles/app/browser'
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
.finder-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 4px 8px; }
.finder-hint { padding: 4px 8px; font-size: 12px; opacity: 0.6; }
.finder-row { display: flex; align-items: center; gap: 4px; width: 100%; min-width: 0; padding: 2px 8px; border: 0; border-radius: 4px; background: transparent; color: var(--text); font: inherit; font-family: ui-monospace, Menlo, monospace; font-size: 12px; text-align: left; }
.finder-row:hover { background: color-mix(in srgb, var(--text) 7%, transparent); }
.finder-folder { opacity: 0.7; }
.finder-row.is-selected { background: var(--focus); color: var(--on-focus); }
.finder-twisty { flex: none; width: 12px; opacity: 0.55; }
.finder-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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

	const tree = useMemo(() => buildTree(state.files), [state.files])
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
				<div className="finder-list">
					{state.loading ? (
						<p className="finder-hint">Loading…</p>
					) : state.files.length === 0 ? (
						<p className="finder-hint">No files yet</p>
					) : (
						<TreeNode
							node={tree}
							depth={0}
							selectedPath={viewing}
							onSelect={(path) => void client.setView({ path })}
						/>
					)}
				</div>
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

type FileItem = { path: string }
type Node = { name: string; path: string; children: Node[]; files: FileItem[] }

function buildTree(files: FileItem[]): Node {
	const root: Node = { name: '', path: '/', children: [], files: [] }
	const child = (node: Node, name: string, path: string) => {
		let found = node.children.find((c) => c.name === name)
		if (!found) {
			found = { name, path, children: [], files: [] }
			node.children.push(found)
		}
		return found
	}
	for (const file of files) {
		const parts = file.path.split('/').filter(Boolean)
		let node = root
		let path = ''
		for (const part of parts.slice(0, -1)) {
			path = `${path}/${part}`
			node = child(node, part, path)
		}
		node.files.push(file)
	}
	const sort = (node: Node) => {
		node.children.sort((a, b) => a.name.localeCompare(b.name))
		node.files.sort((a, b) => basename(a.path).localeCompare(basename(b.path)))
		for (const c of node.children) sort(c)
	}
	sort(root)
	return root
}

function TreeNode(props: {
	node: Node
	depth: number
	selectedPath: string | null
	onSelect: (path: string) => void
}) {
	return (
		<>
			{props.node.children.map((node) => (
				<FolderRow key={node.path} {...props} node={node} depth={props.depth} />
			))}
			{props.node.files.map((file) => (
				<FileRow
					key={file.path}
					path={file.path}
					depth={props.depth}
					selected={file.path === props.selectedPath}
					onSelect={props.onSelect}
				/>
			))}
		</>
	)
}

function FolderRow(props: {
	node: Node
	depth: number
	selectedPath: string | null
	onSelect: (path: string) => void
}) {
	const [open, setOpen] = useState(true)
	return (
		<div>
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="finder-row finder-folder"
				style={{ paddingLeft: props.depth * 12 + 8 }}
				title={props.node.path}
			>
				<span className="finder-twisty">{open ? '▾' : '▸'}</span>
				<span className="finder-name">{props.node.name}</span>
			</button>
			{open ? <TreeNode {...props} depth={props.depth + 1} /> : null}
		</div>
	)
}

function FileRow(props: {
	path: string
	depth: number
	selected: boolean
	onSelect: (path: string) => void
}) {
	return (
		<button
			type="button"
			onClick={() => props.onSelect(props.path)}
			className={props.selected ? 'finder-row is-selected' : 'finder-row'}
			style={{ paddingLeft: props.depth * 12 + 8 }}
			title={props.path}
		>
			<span className="finder-twisty">▹</span>
			<span className="finder-name">{basename(props.path)}</span>
		</button>
	)
}
