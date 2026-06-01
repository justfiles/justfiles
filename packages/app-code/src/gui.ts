import { defineGUI } from '@justfiles/app/browser'
import { type CodeApp, type CodeState, initialState, isCodeState } from './app'
import { createEditor } from './editor'

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
		// `editorPath` is the file the CodeMirror buffer currently holds;
		// `localDirty` mirrors `state.dirty` but is set synchronously so we only
		// dispatch `edit` once per clean→dirty transition (not on every keystroke).
		let editorPath: string | null = null
		let localDirty = false

		const writer = createWriter((path, content) => {
			localDirty = false
			void ctx.client
				.write({ path, content })
				.then(() => {
					// Auto-rebuild keeps a live preview current as you type. Only
					// fires once a preview exists — nothing compiles until ⟳ Run.
					if (current.previewId) void ctx.client.run({}).catch(() => {})
				})
				.catch(() => {})
		}, 400)
		const editor = createEditor((content) => {
			if (!editorPath) return
			if (!localDirty) {
				localDirty = true
				void ctx.client.edit({}).catch(() => {})
			}
			writer.push(editorPath, content)
		})

		// --- chrome built once; only the dynamic parts below are patched, so the
		// editor element is never re-parented (which would drop focus mid-edit) ---
		const shell = div({
			display: 'flex',
			height: '100%',
			width: '100%',
			background: '#ffffff',
			color: '#1d1d1f',
			fontFamily: 'var(--font-ui)',
			fontSize: 'var(--text-ui)'
		})

		const sidebar = div({
			width: '260px',
			flex: '0 0 auto',
			background: '#f5f5f7',
			borderRight: '1px solid #d2d2d7',
			display: 'flex',
			flexDirection: 'column'
		})
		const sideHeader = div({
			display: 'flex',
			alignItems: 'center',
			gap: '8px',
			padding: '8px 10px',
			borderBottom: '1px solid #e3e3e6'
		})
		const sideTitle = div({
			fontSize: '11px',
			fontWeight: '700',
			letterSpacing: '0.08em',
			textTransform: 'uppercase',
			color: '#86868b'
		})
		sideTitle.textContent = 'Explorer'
		const refresh = smallButton('Refresh')
		refresh.style.marginLeft = 'auto'
		refresh.onclick = () => openProject(true)
		sideHeader.append(sideTitle, refresh)
		const projectLabel = div({
			padding: '8px 10px',
			borderBottom: '1px solid #e3e3e6',
			color: '#86868b',
			fontSize: '12px'
		})
		const treeContainer = div({ flex: '1 1 auto', minHeight: '0', overflow: 'auto' })
		sidebar.append(sideHeader, projectLabel, treeContainer)

		const main = div({ display: 'flex', flex: '1 1 auto', minWidth: '0', flexDirection: 'column' })
		const topbar = div({
			display: 'flex',
			alignItems: 'center',
			gap: '8px',
			padding: '8px 10px',
			background: '#f5f5f7',
			borderBottom: '1px solid #d2d2d7'
		})
		const run = document.createElement('button')
		run.type = 'button'
		run.disabled = true
		run.textContent = '⟳ Run'
		Object.assign(run.style, {
			background: '#ffffff',
			border: '1px solid #d2d2d7',
			borderRadius: '6px',
			color: '#86868b',
			font: 'inherit',
			fontWeight: '700',
			opacity: '0.6',
			padding: '5px 10px'
		})
		// ⟳ Run/Restart: re-run from clean state (wipes the draft's persisted
		// state) and reveal the live preview. Auto-rebuild on save keeps it live
		// in between; this button is the explicit, stateful restart.
		// Chain (not fire-and-forget two dispatches): `run` is slow (it compiles)
		// and dispatches aren't serialized per app, so a concurrent `setPane`
		// would be clobbered by run's late state write. Awaiting orders them.
		run.onclick = () => {
			void ctx.client
				.setPane({ pane: 'preview' })
				.then(() => ctx.client.run({ reset: true }))
				.catch(() => {})
		}
		const title = div({
			marginLeft: '8px',
			minWidth: '0',
			overflow: 'hidden',
			textOverflow: 'ellipsis',
			whiteSpace: 'nowrap'
		})
		const segment = div({
			display: 'flex',
			marginLeft: 'auto',
			border: '1px solid #d2d2d7',
			borderRadius: '6px',
			overflow: 'hidden'
		})
		const segEditor = segButton('Editor')
		const segPreview = segButton('Preview')
		segEditor.onclick = () => void ctx.client.setPane({ pane: 'editor' }).catch(() => {})
		segPreview.onclick = () => void ctx.client.setPane({ pane: 'preview' }).catch(() => {})
		segment.append(segEditor, segPreview)
		topbar.append(run, title, segment)

		const editorArea = div({
			position: 'relative',
			flex: '1 1 auto',
			minHeight: '0',
			display: 'flex',
			flexDirection: 'column'
		})
		const editorHost = div({ flex: '1 1 auto', minHeight: '0', overflow: 'hidden' })
		editorHost.append(editor.dom)
		const message = document.createElement('pre')
		Object.assign(message.style, {
			flex: '1 1 auto',
			margin: '0',
			minHeight: '0',
			overflow: 'auto',
			padding: '18px',
			background: '#ffffff',
			fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
			fontSize: '13px',
			lineHeight: '1.55',
			whiteSpace: 'pre-wrap'
		})
		const previewArea = div({
			position: 'relative',
			flex: '1 1 auto',
			minHeight: '0',
			boxSizing: 'border-box',
			overflow: 'hidden',
			padding: '22px',
			background: '#d8d8dd',
			display: 'flex'
		})
		const previewWindow = div({
			flex: '1 1 auto',
			minWidth: '0',
			minHeight: '0',
			display: 'flex',
			flexDirection: 'column',
			background: '#ffffff',
			border: '1px solid #b9b9bf',
			borderRadius: '10px',
			boxShadow: '0 18px 40px rgba(0, 0, 0, 0.18)',
			overflow: 'hidden'
		})
		const previewChrome = div({
			flex: '0 0 auto',
			height: '30px',
			display: 'flex',
			alignItems: 'center',
			gap: '8px',
			padding: '0 10px',
			background: 'linear-gradient(#f9f9fa, #e6e6ea)',
			borderBottom: '1px solid #c7c7cc'
		})
		const trafficLights = div({ display: 'flex', gap: '6px', width: '52px' })
		for (const color of ['#ff5f57', '#ffbd2e', '#28c840']) {
			trafficLights.append(
				div({
					width: '12px',
					height: '12px',
					borderRadius: '999px',
					background: color,
					border: '1px solid rgba(0, 0, 0, 0.16)'
				})
			)
		}
		const previewTitle = div({
			flex: '1 1 auto',
			overflow: 'hidden',
			textOverflow: 'ellipsis',
			whiteSpace: 'nowrap',
			textAlign: 'center',
			color: '#6e6e73',
			fontSize: '12px',
			fontWeight: '600'
		})
		previewChrome.append(trafficLights, previewTitle, div({ width: '52px' }))
		// Stable slot the devkit capability parents the live preview into. Built
		// once inside the chrome and only toggled via its parent — its children
		// belong to the host, so we never replaceChildren it ourselves (that would
		// drop the canvas).
		const previewSlot = div({
			position: 'relative',
			flex: '1 1 auto',
			minHeight: '0',
			overflow: 'hidden',
			background: '#ffffff'
		})
		previewSlot.dataset.previewSlot = ''
		previewWindow.append(previewChrome, previewSlot)
		previewArea.append(previewWindow)
		const errorStrip = document.createElement('pre')
		Object.assign(errorStrip.style, {
			flex: '0 0 auto',
			margin: '0',
			maxHeight: '30%',
			overflow: 'auto',
			padding: '10px 14px',
			background: '#fff5f5',
			borderTop: '1px solid #f3c0c0',
			color: '#c41a16',
			fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
			fontSize: '12px',
			lineHeight: '1.5',
			whiteSpace: 'pre-wrap'
		})
		errorStrip.style.display = 'none'
		editorArea.append(editorHost, message, previewArea, errorStrip)
		main.append(topbar, editorArea)
		shell.append(sidebar, main)
		el.replaceChildren(shell)

		const onSelect = (path: string) => {
			if (path === current.selectedPath) return
			writer.flush() // persist pending edits to the current file before switching
			void ctx.client.select({ path }).catch(() => {})
		}

		const patch = () => {
			projectLabel.textContent = `Project: ${current.slug}`
			const name = current.selectedPath ?? 'No file selected'
			title.textContent = current.selectedPath && current.dirty ? `● ${name}` : name
			treeContainer.replaceChildren(...sidebarBody(current, loadError, projectLoaded, onSelect))
			run.disabled = !projectLoaded
			run.style.opacity = projectLoaded ? '1' : '0.6'
			run.style.color = projectLoaded ? '#1d1d1f' : '#86868b'
			const preview = current.rightPane === 'preview'
			setSegment(segEditor, !preview)
			setSegment(segPreview, preview)
			const ready =
				!preview &&
				!!current.selectedPath &&
				source.path === current.selectedPath &&
				source.content !== null
			previewTitle.textContent = `Preview — ${current.slug}`
			previewArea.style.display = preview ? 'flex' : 'none'
			editorHost.style.display = ready ? '' : 'none'
			message.style.display = !preview && !ready ? '' : 'none'
			if (!preview && !ready) {
				message.textContent = sourceText(current.selectedPath, source)
				message.style.color = source.error ? '#c41a16' : '#86868b'
			}
			errorStrip.style.display = current.diagnostics.length > 0 ? '' : 'none'
			if (current.diagnostics.length > 0) errorStrip.textContent = current.diagnostics.join('\n')
		}

		const syncSource = () => {
			const path = current.selectedPath
			if (!path) {
				if (source.path !== null) readToken++
				source = { path: null, content: null, error: null }
				editorPath = null
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
					editorPath = path
					localDirty = false
					editor.setDoc(content)
					patch()
				})
				.catch((err) => {
					if (!mounted || token !== readToken) return
					source = { path, content: null, error: messageOf(err) }
					patch()
				})
		}

		const openProject = (showLoading: boolean) => {
			didOpen = true
			projectLoaded = false
			if (showLoading) patch()
			void ctx.client
				.open({ slug: current.slug })
				.then((next) => {
					if (!mounted) return
					projectLoaded = true
					loadError = null
					current = stateOrInitial(next)
					syncSource()
					patch()
				})
				.catch((err) => {
					if (!mounted) return
					projectLoaded = true
					loadError = messageOf(err)
					patch()
				})
		}

		const update = (next: CodeState | null) => {
			current = stateOrInitial(next)
			loadError = null
			syncSource()
			if (!didOpen) openProject(false)
			patch()
		}

		update(state)
		return {
			update,
			unmount() {
				mounted = false
				readToken++
				writer.flush() // persist the last in-flight edit on close
				editor.destroy()
				el.replaceChildren()
			}
		}
	}
})

function sidebarBody(
	state: CodeState,
	loadError: string | null,
	projectLoaded: boolean,
	onSelect: (path: string) => void
): HTMLElement[] {
	const body: HTMLElement[] = []
	if (loadError) body.push(errorBlock(loadError))
	body.push(
		state.files.length === 0
			? emptyBlock(
					loadError
						? 'Could not load project.'
						: projectLoaded
							? 'Empty project.'
							: 'Loading project…'
				)
			: renderTree(buildTree(state.files), state.selectedPath, onSelect)
	)
	return body
}

function sourceText(path: string | null, source: SourceView): string {
	if (!path) return 'Select a file to edit.'
	return source.error ?? 'Loading…'
}

// Debounced, path-aware file writer. Coalesces rapid edits to one file; if the
// edited path changes (the user switched files) the pending write fires first
// so no buffer is lost.
function createWriter(write: (path: string, content: string) => void, ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined
	let pending: { path: string; content: string } | null = null
	const fire = () => {
		if (timer) {
			clearTimeout(timer)
			timer = undefined
		}
		if (!pending) return
		const { path, content } = pending
		pending = null
		write(path, content)
	}
	return {
		push(path: string, content: string) {
			if (pending && pending.path !== path) fire()
			pending = { path, content }
			if (timer) clearTimeout(timer)
			timer = setTimeout(fire, ms)
		},
		flush: fire
	}
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
	const tree = div({ padding: '10px 6px' })
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
			color: '#6e6e73',
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
		background: selected ? '#007aff' : 'transparent',
		border: '0',
		borderRadius: '6px',
		color: selected ? '#ffffff' : '#1d1d1f',
		cursor: 'default',
		font: '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
		textAlign: 'left'
	})
	return button
}

function segButton(label: string) {
	const button = document.createElement('button')
	button.type = 'button'
	button.textContent = label
	Object.assign(button.style, {
		border: '0',
		cursor: 'default',
		font: 'inherit',
		fontSize: '12px',
		fontWeight: '600',
		padding: '5px 12px'
	})
	return button
}

function setSegment(button: HTMLButtonElement, active: boolean) {
	button.style.background = active ? '#007aff' : '#ffffff'
	button.style.color = active ? '#ffffff' : '#1d1d1f'
}

function smallButton(label: string) {
	const button = document.createElement('button')
	button.type = 'button'
	button.textContent = label
	Object.assign(button.style, {
		background: '#ffffff',
		border: '1px solid #d2d2d7',
		borderRadius: '6px',
		color: '#1d1d1f',
		cursor: 'default',
		font: 'inherit',
		fontSize: '12px',
		padding: '4px 9px'
	})
	return button
}

function emptyBlock(text: string) {
	const block = div({ color: '#86868b', fontSize: '12px', padding: '12px' })
	block.textContent = text
	return block
}

function errorBlock(text: string) {
	const block = div({ color: '#c41a16', fontSize: '12px', padding: '8px 10px' })
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
