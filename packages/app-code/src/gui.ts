import type { Client } from '@justfiles/app'
import { defineGUI } from '@justfiles/app/browser'
import { type CodeApp, type CodeFile, type CodeState, initialState } from './app'

const stateOrInitial = (value: unknown): CodeState =>
	value && typeof value === 'object' && 'files' in value && 'mode' in value
		? (value as CodeState)
		: initialState

const messages = [
	{ from: 'Agent', text: 'I found the route config and app entrypoint.' },
	{ from: 'You', text: 'Can you preview what this app looks like?' },
	{ from: 'Agent', text: 'Here is a mocked live GUI preview using the current app data.' }
]

export const gui = defineGUI<CodeApp>({
	mount(el, state, ctx) {
		const render = (next: CodeState | null) => renderLayout(el, stateOrInitial(next), ctx.client)
		render(state)
		return {
			update: render,
			unmount() {
				el.replaceChildren()
			}
		}
	}
})

function renderLayout(el: HTMLElement, state: CodeState, client: Client<CodeApp>) {
	const selected = state.files.find((file) => file.path === state.selectedPath) ?? state.files[0]
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
	sideTitle.textContent = state.mode === 'code' ? 'Explorer' : 'Agent'
	const toggle = smallButton(state.mode === 'code' ? 'Agent' : 'Code')
	toggle.style.marginLeft = 'auto'
	toggle.onclick = () => void client.toggleMode({})
	sideHeader.append(sideTitle, toggle)
	sidebar.append(sideHeader)
	if (state.mode === 'code') {
		sidebar.append(
			renderTree(buildTree(state.files), state.selectedPath, (path) => {
				void client.selectFile({ path })
			})
		)
	} else {
		sidebar.append(renderChat())
	}

	const main = div({ display: 'flex', flex: '1 1 auto', minWidth: '0', flexDirection: 'column' })
	const topbar = div({
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		padding: '8px 10px',
		background: '#1f2937',
		borderBottom: '1px solid #374151'
	})
	const play = document.createElement('button')
	play.type = 'button'
	play.textContent = '▶ Play'
	Object.assign(play.style, {
		background: '#22c55e',
		border: '0',
		borderRadius: '6px',
		color: '#052e16',
		cursor: 'default',
		font: 'inherit',
		fontWeight: '700',
		padding: '5px 10px'
	})
	const title = div({
		marginLeft: '8px',
		minWidth: '0',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap'
	})
	title.textContent =
		state.mode === 'code' ? (selected?.path ?? 'No file selected') : 'Live app preview'
	topbar.append(play, title)

	main.append(topbar, state.mode === 'code' ? renderSource(selected) : renderAppPreview())
	shell.append(sidebar, main)
	el.replaceChildren(shell)
}

function renderSource(file: CodeFile | undefined) {
	const preview = document.createElement('pre')
	preview.textContent = file?.content ?? 'Select a file to preview.'
	Object.assign(preview.style, {
		flex: '1 1 auto',
		margin: '0',
		minHeight: '0',
		overflow: 'auto',
		padding: '18px',
		background: '#111827',
		color: '#e5e7eb',
		fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
		fontSize: '13px',
		lineHeight: '1.55',
		whiteSpace: 'pre-wrap'
	})
	return preview
}

function renderChat() {
	const chat = div({
		display: 'flex',
		flex: '1 1 auto',
		minHeight: '0',
		flexDirection: 'column',
		gap: '10px',
		overflow: 'auto',
		padding: '12px'
	})
	for (const message of messages) {
		const bubble = div({
			alignSelf: message.from === 'You' ? 'flex-end' : 'flex-start',
			maxWidth: '88%',
			padding: '8px 10px',
			background: message.from === 'You' ? '#2563eb' : '#1f2937',
			border: '1px solid #334155',
			borderRadius: '10px',
			color: '#e5e7eb',
			fontSize: '12px',
			lineHeight: '1.4'
		})
		const from = div({ marginBottom: '4px', color: '#93c5fd', fontSize: '10px', fontWeight: '700' })
		from.textContent = message.from
		const text = div({})
		text.textContent = message.text
		bubble.append(from, text)
		chat.append(bubble)
	}
	const input = div({
		marginTop: 'auto',
		padding: '8px 10px',
		background: '#020617',
		border: '1px solid #334155',
		borderRadius: '8px',
		color: '#64748b',
		fontSize: '12px'
	})
	input.textContent = 'Ask agent…'
	chat.append(input)
	return chat
}

function renderAppPreview() {
	const page = div({
		flex: '1 1 auto',
		minHeight: '0',
		overflow: 'auto',
		padding: '24px',
		background: '#e5e7eb',
		color: '#111827'
	})
	const app = div({
		maxWidth: '860px',
		margin: '0 auto',
		background: '#ffffff',
		border: '1px solid #d1d5db',
		borderRadius: '16px',
		boxShadow: '0 18px 45px rgba(15, 23, 42, 0.18)',
		overflow: 'hidden'
	})
	const nav = div({
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '14px 18px',
		background: '#111827',
		color: '#f9fafb'
	})
	nav.append(
		textDiv('Mock Dashboard', { fontWeight: '800' }),
		textDiv('Connected', { color: '#86efac' })
	)
	const body = div({
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '16px',
		padding: '18px'
	})
	body.append(
		card('Revenue', '$24,800', '+12% from last week'),
		card('Active users', '1,284', '83 online now'),
		listCard('Tasks', ['Ship IDE layout', 'Wire agent mode', 'Replace mock preview']),
		formCard()
	)
	app.append(nav, body)
	page.append(app)
	return page
}

function card(title: string, value: string, note: string) {
	const box = panel()
	box.append(textDiv(title, { color: '#6b7280', fontSize: '12px' }))
	box.append(textDiv(value, { marginTop: '8px', fontSize: '28px', fontWeight: '800' }))
	box.append(textDiv(note, { marginTop: '6px', color: '#16a34a', fontSize: '12px' }))
	return box
}

function listCard(title: string, items: string[]) {
	const box = panel()
	box.append(textDiv(title, { marginBottom: '10px', fontWeight: '800' }))
	for (const item of items) box.append(textDiv(`✓ ${item}`, { marginTop: '6px', color: '#374151' }))
	return box
}

function formCard() {
	const box = panel()
	box.append(textDiv('Quick action', { marginBottom: '10px', fontWeight: '800' }))
	const input = document.createElement('input')
	input.value = 'Generate release notes'
	Object.assign(input.style, {
		boxSizing: 'border-box',
		width: '100%',
		padding: '9px 10px',
		border: '1px solid #d1d5db',
		borderRadius: '8px',
		font: 'inherit'
	})
	const button = smallButton('Run mock action')
	Object.assign(button.style, { marginTop: '10px', background: '#2563eb', color: '#ffffff' })
	box.append(input, button)
	return box
}

type TreeNode = { name: string; path: string; folders: TreeNode[]; files: CodeFile[] }

function buildTree(files: CodeFile[]): TreeNode {
	const root: TreeNode = { name: '', path: '/', folders: [], files: [] }
	for (const file of files) {
		const parts = file.path.split('/').filter(Boolean)
		let node = root
		let path = ''
		for (const part of parts.slice(0, -1)) {
			path = `${path}/${part}`
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
	node.files.sort((a, b) => basename(a.path).localeCompare(basename(b.path)))
	for (const folder of node.folders) sortTree(folder)
}

function renderTree(node: TreeNode, selectedPath: string, onSelect: (path: string) => void) {
	const tree = div({ flex: '1 1 auto', minHeight: '0', overflow: 'auto', padding: '10px 6px' })
	appendNode(tree, node, 0, selectedPath, onSelect)
	return tree
}

function appendNode(
	parent: HTMLElement,
	node: TreeNode,
	depth: number,
	selectedPath: string,
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
		parent.append(fileButton(file, depth, file.path === selectedPath, onSelect))
}

function fileButton(
	file: CodeFile,
	depth: number,
	selected: boolean,
	onSelect: (path: string) => void
) {
	const button = document.createElement('button')
	button.type = 'button'
	button.textContent = `⌞ ${basename(file.path)}`
	button.title = file.path
	button.onclick = () => onSelect(file.path)
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

function panel() {
	return div({
		padding: '16px',
		background: '#f9fafb',
		border: '1px solid #e5e7eb',
		borderRadius: '12px'
	})
}

function textDiv(text: string, style: Partial<CSSStyleDeclaration> = {}) {
	const element = div(style)
	element.textContent = text
	return element
}

function basename(path: string) {
	return path.split('/').filter(Boolean).at(-1) ?? path
}

function div(style: Partial<CSSStyleDeclaration>) {
	const element = document.createElement('div')
	Object.assign(element.style, style)
	return element
}
