import { defineGUI } from '@justfiles/app/browser'
import {
	type CodeApp,
	type CodeState,
	type CodeStatus,
	initialState,
	isCodeState,
	statusOf
} from './app'
import { createEditor } from './editor'

const stateOrInitial = (value: unknown): CodeState => (isCodeState(value) ? value : initialState)

// Derived toolbar label + color. Just a colored state label — details belong in
// the bottom message area.
const STATUS: Record<CodeStatus, { label: string; color: string }> = {
	idle: { label: 'Idle', color: '#86868b' },
	updating: { label: 'Updating', color: '#6e8efb' },
	building: { label: 'Building', color: '#007aff' },
	live: { label: 'Live', color: '#1aa251' },
	'needs-fixes': { label: 'Needs fixes', color: '#d9822b' },
	crashed: { label: 'Crashed', color: '#c41a16' }
}

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
		let running = false // a `run` is in flight (client-local) → drives the `Building` label
		let rerun = false // a write landed during a run → rebuild once it resolves
		// `editorPath` is the file the CodeMirror buffer currently holds;
		// `localDirty` is set synchronously on the first keystroke so the title
		// shows the dirty dot immediately (not after the debounced write lands).
		let editorPath: string | null = null
		let localDirty = false

		const writer = createWriter((path, content) => {
			localDirty = false
			// Auto-rebuild keeps the live App current as you type: persist, then run
			// once the write resolves. `runBuild` is single-flight, so a burst of
			// edits collapses to one trailing run.
			void ctx.client
				.write({ path, content })
				.then(() => runBuild())
				.catch(() => {})
		}, 1000)
		const editor = createEditor((content) => {
			if (!editorPath) return
			if (!localDirty) {
				localDirty = true
				patch()
			}
			writer.push(editorPath, content)
		})

		// --- chrome built once; only the dynamic parts below are patched, so the
		// editor element and the preview slot are never re-parented (which would
		// drop editor focus / the live App) ---
		const shell = div({
			display: 'flex',
			flexDirection: 'column',
			height: '100%',
			width: '100%',
			background: '#ffffff',
			color: '#1d1d1f',
			fontFamily: 'var(--font-ui)',
			fontSize: 'var(--text-ui)'
		})

		// Toolbar: [ state ]   [ Source | App ]   [ Install ]
		const toolbar = div({
			display: 'flex',
			alignItems: 'center',
			gap: '8px',
			padding: '8px 12px',
			background: '#f5f5f7',
			borderBottom: '1px solid #d2d2d7'
		})
		const stateLabel = div({
			flex: '1 1 0',
			minWidth: '0',
			fontSize: '12px',
			fontWeight: '600',
			whiteSpace: 'nowrap'
		})

		const segment = div({
			display: 'flex',
			flex: '0 0 auto',
			border: '1px solid #d2d2d7',
			borderRadius: '6px',
			overflow: 'hidden'
		})
		const segSource = segButton('Source')
		const segApp = segButton('App')
		segSource.onclick = () => void ctx.client.setView({ view: 'source' }).catch(() => {})
		segApp.onclick = () => void ctx.client.setView({ view: 'app' }).catch(() => {})
		segment.append(segSource, segApp)

		const rightGroup = div({
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'flex-end',
			flex: '1 1 0',
			minWidth: '0'
		})
		// Primary shipping action. Disabled placeholder until Phase 4 wires it to
		// `canInstall(state)` and the devkit `install` capability.
		const install = document.createElement('button')
		install.type = 'button'
		install.textContent = 'Install'
		install.disabled = true
		Object.assign(install.style, {
			background: '#007aff',
			border: '0',
			borderRadius: '6px',
			color: '#ffffff',
			cursor: 'default',
			font: 'inherit',
			fontSize: '12px',
			fontWeight: '600',
			opacity: '0.4',
			padding: '5px 14px'
		})
		rightGroup.append(install)
		toolbar.append(stateLabel, segment, rightGroup)

		// Content: Source view (file tree + editor) and App view (full preview
		// slot) share the area; only one is shown at a time via `display`.
		const content = div({ display: 'flex', flex: '1 1 auto', minHeight: '0' })

		const sourceView = div({ display: 'flex', flex: '1 1 auto', minWidth: '0', minHeight: '0' })
		const sidebar = div({
			width: '240px',
			flex: '0 0 auto',
			minHeight: '0',
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
		const projectLabel = div({
			flex: '1 1 auto',
			minWidth: '0',
			overflow: 'hidden',
			textOverflow: 'ellipsis',
			whiteSpace: 'nowrap',
			color: '#1d1d1f',
			fontSize: '12px',
			fontWeight: '600'
		})
		const refresh = smallButton('Refresh')
		refresh.onclick = () => openProject(true)
		sideHeader.append(projectLabel, refresh)
		const treeContainer = div({ flex: '1 1 auto', minHeight: '0', overflow: 'auto' })
		sidebar.append(sideHeader, treeContainer)

		const editorPane = div({
			flex: '1 1 auto',
			minWidth: '0',
			minHeight: '0',
			display: 'flex',
			flexDirection: 'column'
		})
		const editorTitle = div({
			flex: '0 0 auto',
			padding: '6px 12px',
			borderBottom: '1px solid #e3e3e6',
			color: '#6e6e73',
			fontSize: '12px',
			overflow: 'hidden',
			textOverflow: 'ellipsis',
			whiteSpace: 'nowrap'
		})
		const editorHost = div({ flex: '1 1 auto', minHeight: '0', overflow: 'hidden' })
		editorHost.append(editor.dom)
		// Fallback shown in place of the editor when no file is loaded yet.
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
		editorPane.append(editorTitle, editorHost, message)
		sourceView.append(sidebar, editorPane)

		// App view: the full live app region. No file tree, no editor or window
		// chrome — just the stable slot the devkit capability parents the live App
		// into. Built once and only toggled via its parent; its children belong to
		// the host, so we never replaceChildren it ourselves.
		const appView = div({
			display: 'none',
			flex: '1 1 auto',
			minWidth: '0',
			minHeight: '0',
			background: '#ffffff'
		})
		const previewSlot = div({
			position: 'relative',
			flex: '1 1 auto',
			minWidth: '0',
			minHeight: '0',
			overflow: 'hidden',
			background: '#ffffff'
		})
		previewSlot.dataset.previewSlot = ''
		appView.append(previewSlot)
		content.append(sourceView, appView)

		// Bottom message area: latest build message + diagnostics.
		const bottomBar = div({
			flex: '0 0 auto',
			display: 'none',
			flexDirection: 'column',
			gap: '6px',
			maxHeight: '40%',
			overflow: 'auto',
			padding: '8px 12px',
			background: '#f5f5f7',
			borderTop: '1px solid #d2d2d7'
		})
		const buildMessage = div({ fontSize: '12px', whiteSpace: 'pre-wrap' })
		const diagnostics = document.createElement('pre')
		Object.assign(diagnostics.style, {
			margin: '0',
			color: '#c41a16',
			fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
			fontSize: '12px',
			lineHeight: '1.5',
			whiteSpace: 'pre-wrap'
		})
		diagnostics.style.display = 'none'
		bottomBar.append(buildMessage, diagnostics)

		shell.append(toolbar, content, bottomBar)
		el.replaceChildren(shell)

		const onSelect = (path: string) => {
			if (path === current.selectedPath) return
			writer.flush() // persist pending edits to the current file before switching
			void ctx.client.select({ path }).catch(() => {})
		}

		const patch = () => {
			// Toolbar state label
			const badge = STATUS[statusOf(current, running)]
			stateLabel.textContent = `● ${badge.label}`
			stateLabel.style.color = badge.color

			// Segmented control + view toggle
			const app = current.view === 'app'
			setSegment(segSource, !app)
			setSegment(segApp, app)
			sourceView.style.display = app ? 'none' : 'flex'
			appView.style.display = app ? 'flex' : 'none'

			// Sidebar
			projectLabel.textContent = current.slug
			treeContainer.replaceChildren(...sidebarBody(current, loadError, projectLoaded, onSelect))

			// Editor pane: file title + editor/fallback
			const name = current.selectedPath ?? 'No file selected'
			editorTitle.textContent = current.selectedPath && localDirty ? `● ${name}` : name
			const ready =
				!!current.selectedPath && source.path === current.selectedPath && source.content !== null
			editorHost.style.display = ready ? '' : 'none'
			message.style.display = ready ? 'none' : ''
			if (!ready) {
				message.textContent = sourceText(current.selectedPath, source)
				message.style.color = source.error ? '#c41a16' : '#86868b'
			}

			// Bottom message area
			const build = current.build
			bottomBar.style.display = build ? 'flex' : 'none'
			if (build) {
				buildMessage.textContent = build.message
				buildMessage.style.color = build.result === 'ok' ? '#1aa251' : '#c41a16'
				diagnostics.style.display = build.diagnostics.length > 0 ? '' : 'none'
				if (build.diagnostics.length > 0) diagnostics.textContent = build.diagnostics.join('\n')
			}
		}

		// Single-flight rebuild. While a run is in flight, a new write just marks a
		// rerun that fires when the current run resolves — so two devkit.runs never
		// clobber the same preview. Each run records the hash it built, so the
		// toolbar stays honest about current vs previous regardless of coalescing.
		const runBuild = async () => {
			if (running) {
				rerun = true
				return
			}
			running = true
			patch()
			try {
				await ctx.client.run({})
			} catch {
			} finally {
				running = false
				if (rerun) {
					rerun = false
					void runBuild()
				} else patch()
			}
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
			running = true // `open` compiles the initial build → show `Building`
			if (showLoading) patch()
			void ctx.client
				.open({ slug: current.slug })
				.then((next) => {
					if (!mounted) return
					projectLoaded = true
					loadError = null
					current = stateOrInitial(next)
					syncSource()
				})
				.catch((err) => {
					if (!mounted) return
					projectLoaded = true
					loadError = messageOf(err)
				})
				.finally(() => {
					if (!mounted) return
					running = false
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
