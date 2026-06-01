import type { Client } from '@justfiles/app'
import { defineGUI } from '@justfiles/app/browser'
import { type CodeApp, type CodeState, initialState, isCodeState } from './app'

const stateOrInitial = (value: unknown): CodeState => (isCodeState(value) ? value : initialState)

type SourceView = {
	path: string | null
	content: string | null
	error: string | null
}

export const gui = defineGUI<CodeApp>({
	mount(el, state, ctx) {
		let current = stateOrInitial(state)
		let source: SourceView = { path: null, content: null, error: null }
		let loadError: string | null = null
		let readToken = 0
		let didOpen = false
		let projectLoaded = false
		let mounted = true

		const paint = () =>
			renderLayout(el, current, ctx.client, source, loadError, projectLoaded, () =>
				openProject(true)
			)

		const syncSource = () => {
			const path = current.selectedPath
			if (!path) {
				if (source.path !== null) readToken++
				source = { path: null, content: null, error: null }
				return
			}
			if (source.path === path) return
			const token = ++readToken
			source = { path, content: null, error: null }
			void ctx.client
				.readFile({ path })
				.then((content) => {
					if (!mounted || token !== readToken) return
					source = { path, content, error: null }
					paint()
				})
				.catch((err) => {
					if (!mounted || token !== readToken) return
					source = { path, content: null, error: messageOf(err) }
					paint()
				})
		}

		const openProject = (showLoading: boolean) => {
			didOpen = true
			projectLoaded = false
			if (showLoading) paint()
			void ctx.client
				.open({ slug: current.slug })
				.then((next) => {
					if (!mounted) return
					projectLoaded = true
					loadError = null
					current = stateOrInitial(next)
					syncSource()
					paint()
				})
				.catch((err) => {
					if (!mounted) return
					projectLoaded = true
					loadError = messageOf(err)
					paint()
				})
		}

		const update = (next: CodeState | null) => {
			current = stateOrInitial(next)
			loadError = null
			syncSource()
			if (!didOpen) openProject(false)
			paint()
		}

		update(state)
		return {
			update,
			unmount() {
				mounted = false
				readToken++
				el.replaceChildren()
			}
		}
	}
})

function renderLayout(
	el: HTMLElement,
	state: CodeState,
	client: Client<CodeApp>,
	source: SourceView,
	loadError: string | null,
	projectLoaded: boolean,
	onRefresh: () => void
) {
	const shell = div({
		display: 'flex',
		height: '100%',
		width: '100%',
		background: '#111827',
		color: '#d1d5db',
		fontFamily: 'var(--font-ui)',
		fontSize: 'var(--text-ui)'
	})

	const sidebar = div({
		width: '260px',
		flex: '0 0 auto',
		background: '#0f172a',
		borderRight: '1px solid #263244',
		display: 'flex',
		flexDirection: 'column'
	})
	const sideHeader = div({
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		padding: '8px 10px',
		borderBottom: '1px solid #1e293b'
	})
	const sideTitle = div({
		fontSize: '11px',
		fontWeight: '700',
		letterSpacing: '0.08em',
		textTransform: 'uppercase',
		color: '#94a3b8'
	})
	sideTitle.textContent = 'Explorer'
	const refresh = smallButton('Refresh')
	refresh.style.marginLeft = 'auto'
	refresh.onclick = onRefresh
	sideHeader.append(sideTitle, refresh)
	sidebar.append(sideHeader)
	const project = div({
		padding: '8px 10px',
		borderBottom: '1px solid #1e293b',
		color: '#94a3b8',
		fontSize: '12px'
	})
	project.textContent = `Project: ${state.slug}`
	sidebar.append(project)
	if (loadError) sidebar.append(errorBlock(loadError))
	sidebar.append(
		state.files.length === 0
			? emptyBlock(
					loadError
						? 'Could not load project.'
						: projectLoaded
							? 'Empty project.'
							: 'Loading project…'
				)
			: renderTree(buildTree(state.files), state.selectedPath, (path) => {
					void client.select({ path })
				})
	)

	const main = div({ display: 'flex', flex: '1 1 auto', minWidth: '0', flexDirection: 'column' })
	const topbar = div({
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		padding: '8px 10px',
		background: '#1f2937',
		borderBottom: '1px solid #374151'
	})
	const run = document.createElement('button')
	run.type = 'button'
	run.disabled = true
	run.textContent = '⟳ Run'
	Object.assign(run.style, {
		background: '#334155',
		border: '0',
		borderRadius: '6px',
		color: '#94a3b8',
		font: 'inherit',
		fontWeight: '700',
		opacity: '0.55',
		padding: '5px 10px'
	})
	const title = div({
		marginLeft: '8px',
		minWidth: '0',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap'
	})
	title.textContent = state.selectedPath ?? 'No file selected'
	topbar.append(run, title)

	main.append(topbar, renderSource(state.selectedPath, source))
	shell.append(sidebar, main)
	el.replaceChildren(shell)
}

function renderSource(path: string | null, source: SourceView) {
	const preview = document.createElement('pre')
	preview.textContent = sourceText(path, source)
	Object.assign(preview.style, {
		flex: '1 1 auto',
		margin: '0',
		minHeight: '0',
		overflow: 'auto',
		padding: '18px',
		background: '#111827',
		color: source.error ? '#fca5a5' : '#e5e7eb',
		fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
		fontSize: '13px',
		lineHeight: '1.55',
		whiteSpace: 'pre-wrap'
	})
	return preview
}

function sourceText(path: string | null, source: SourceView): string {
	if (!path) return 'Select a file to preview.'
	if (source.path !== path || source.content === null) return source.error ?? 'Loading…'
	return source.content
}

type TreeNode = { name: string; path: string; folders: TreeNode[]; files: string[] }

function buildTree(files: string[]): TreeNode {
	const root: TreeNode = { name: '', path: '', folders: [], files: [] }
	for (const file of files) {
		const parts = file.split('/').filter(Boolean)
		let node = root
		let path = ''
		for (const part of parts.slice(0, -1)) {
			path = path ? `${path}/${part}` : part
			let folder = node.folders.find((child) => child.name === part)
			if (!folder) {
				folder = { name: part, path, folders: [], files: [] }
				node.folders.push(folder)
			}
			node = folder
		}
		node.files.push(file)
	}
	sortTree(root)
	return root
}

function sortTree(node: TreeNode) {
	node.folders.sort((a, b) => a.name.localeCompare(b.name))
	node.files.sort((a, b) => basename(a).localeCompare(basename(b)))
	for (const folder of node.folders) sortTree(folder)
}

function renderTree(node: TreeNode, selectedPath: string | null, onSelect: (path: string) => void) {
	const tree = div({ flex: '1 1 auto', minHeight: '0', overflow: 'auto', padding: '10px 6px' })
	appendNode(tree, node, 0, selectedPath, onSelect)
	return tree
}

function appendNode(
	parent: HTMLElement,
	node: TreeNode,
	depth: number,
	selectedPath: string | null,
	onSelect: (path: string) => void
) {
	for (const folder of node.folders) {
		const row = div({
			padding: `3px 8px 3px ${depth * 14 + 8}px`,
			color: '#93c5fd',
			fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
			fontSize: '12px'
		})
		row.textContent = `▾ ${folder.name}`
		parent.append(row)
		appendNode(parent, folder, depth + 1, selectedPath, onSelect)
	}
	for (const file of node.files)
		parent.append(fileButton(file, depth, file === selectedPath, onSelect))
}

function fileButton(
	path: string,
	depth: number,
	selected: boolean,
	onSelect: (path: string) => void
) {
	const button = document.createElement('button')
	button.type = 'button'
	button.textContent = `⌞ ${basename(path)}`
	button.title = path
	button.onclick = () => onSelect(path)
	Object.assign(button.style, {
		display: 'block',
		width: '100%',
		padding: `4px 8px 4px ${depth * 14 + 8}px`,
		background: selected ? '#2563eb' : 'transparent',
		border: '0',
		borderRadius: '6px',
		color: selected ? '#eff6ff' : '#d1d5db',
		cursor: 'default',
		font: '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
		textAlign: 'left'
	})
	return button
}

function smallButton(label: string) {
	const button = document.createElement('button')
	button.type = 'button'
	button.textContent = label
	Object.assign(button.style, {
		background: '#334155',
		border: '0',
		borderRadius: '6px',
		color: '#dbeafe',
		cursor: 'default',
		font: 'inherit',
		fontSize: '12px',
		padding: '5px 9px'
	})
	return button
}

function emptyBlock(text: string) {
	const block = div({ color: '#64748b', fontSize: '12px', padding: '12px' })
	block.textContent = text
	return block
}

function errorBlock(text: string) {
	const block = div({ color: '#fca5a5', fontSize: '12px', padding: '8px 10px' })
	block.textContent = text
	return block
}

function messageOf(err: unknown) {
	return err instanceof Error ? err.message : String(err)
}

function basename(path: string) {
	return path.split('/').filter(Boolean).at(-1) ?? path
}

function div(style: Partial<CSSStyleDeclaration>) {
	const element = document.createElement('div')
	Object.assign(element.style, style)
	return element
}
