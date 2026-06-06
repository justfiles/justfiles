import type { Client } from '@justfiles/app'
import { defineGUI } from '@justfiles/app/browser'
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type FinderApp, type FinderState, initialState } from './app.ts'

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
		<div
			className="flex h-full w-full"
			style={{
				background: '#ffffff',
				color: 'var(--text)',
				fontFamily: 'var(--font-ui)',
				fontSize: 'var(--text-ui)'
			}}
		>
			<aside
				className="flex w-56 flex-none flex-col overflow-hidden"
				style={{ background: 'var(--surface)', borderRight: '1px solid var(--rule)' }}
			>
				<header className="flex flex-none items-center gap-2 px-3 py-2">
					<span className="font-medium">Files</span>
					<button
						type="button"
						onClick={() => void client.refresh({})}
						className="ml-auto rounded px-2 py-0.5 text-[11px]"
						style={{ border: '1px solid var(--rule)', background: '#fff' }}
					>
						Refresh
					</button>
				</header>
				{state.error ? <p className="px-3 pb-2 text-xs text-red-700">{state.error}</p> : null}
				<div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
					{state.loading ? (
						<p className="px-2 py-1 text-xs opacity-60">Loading…</p>
					) : state.files.length === 0 ? (
						<p className="px-2 py-1 text-xs opacity-60">No files yet</p>
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
			<section className="flex min-w-0 flex-1 flex-col">
				{viewing ? (
					<>
						<header
							className="flex flex-none items-center gap-2 px-3 py-2"
							style={{ borderBottom: '1px solid var(--rule)' }}
						>
							<span className="truncate font-medium">{basename(viewing)}</span>
							<span className="ml-auto truncate text-[11px] opacity-50">{viewing}</span>
							<button
								type="button"
								onClick={() => void client.clear({})}
								className="rounded px-2 py-0.5 text-[11px]"
								style={{ border: '1px solid var(--rule)', background: '#fff' }}
							>
								Clear
							</button>
						</header>
						<pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5">
							{displayError ? (
								<span style={{ color: '#b91c1c' }}>{displayError}</span>
							) : showPreview ? (
								<>
									{showPreview.content}
									{showPreview.truncated ? (
										<span className="block pt-2 opacity-50">… preview truncated</span>
									) : null}
								</>
							) : (
								<span className="opacity-50">Loading…</span>
							)}
						</pre>
					</>
				) : (
					<div className="flex h-full items-center justify-center text-xs opacity-50">
						Select a file to preview
					</div>
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
				className="flex w-full min-w-0 items-center gap-1 rounded px-2 py-0.5 text-left font-mono text-xs opacity-70"
				style={{ paddingLeft: props.depth * 12 + 8 }}
				title={props.node.path}
			>
				<span className="w-3 opacity-60">{open ? '▾' : '▸'}</span>
				<span className="truncate">{props.node.name}</span>
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
			className="flex w-full min-w-0 items-center gap-1 rounded px-2 py-1 text-left font-mono text-xs"
			style={{
				paddingLeft: props.depth * 12 + 8,
				...(props.selected
					? { background: 'var(--focus)', color: 'var(--on-focus)' }
					: { color: 'var(--text)' })
			}}
			title={props.path}
		>
			<span className="w-3 opacity-50">▹</span>
			<span className="truncate">{basename(props.path)}</span>
		</button>
	)
}
