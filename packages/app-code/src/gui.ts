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
		// `localDirty` is set synchronously on the first keystroke so the tab shows
		// the dirty dot immediately (not after the debounced write lands).
		let editorPath: string | null = null
		let localDirty = false
		// Code-pane fraction of the content width; the user drags the handle to
		// resize. The App fills the rest. Only meaningful while the Code pane shows.
		let split = 0.5

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

		// Toolbar: [ </> Code ]      ● Status      [ Install ]. Left and right groups
		// share the slack equally so the status label stays centered.
		const toolbar = div({
			display: 'flex',
			alignItems: 'center',
			gap: '8px',
			padding: '8px 12px',
			background: '#f5f5f7',
			borderBottom: '1px solid #d2d2d7'
		})
		const leftGroup = div({ display: 'flex', flex: '1 1 0', minWidth: '0', alignItems: 'center' })
		const codeToggle = document.createElement('button')
		codeToggle.type = 'button'
		codeToggle.textContent = '</> Code'
		Object.assign(codeToggle.style, {
			border: '1px solid #d2d2d7',
			borderRadius: '6px',
			cursor: 'default',
			font: 'inherit',
			fontSize: '12px',
			fontWeight: '600',
			padding: '5px 12px',
			whiteSpace: 'nowrap'
		})
		// One non-modal toggle: reveal the Code pane alongside the App, or hide it so
		// the App fills the area (the default for non-technical users).
		codeToggle.onclick = () =>
			void ctx.client
				.setView({ view: current.view === 'source' ? 'app' : 'source' })
				.catch(() => {})
		leftGroup.append(codeToggle)

		const stateLabel = div({
			flex: '0 0 auto',
			textAlign: 'center',
			fontSize: '12px',
			fontWeight: '600',
			whiteSpace: 'nowrap'
		})

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
		toolbar.append(leftGroup, stateLabel, rightGroup)

		// Content: Code pane (file tabs + editor) | drag handle | live App. The Code
		// pane and handle hide when the toggle is off, so the App fills the area.
		const content = div({ display: 'flex', flex: '1 1 auto', minHeight: '0' })

		// Code pane. File tabs replace a tree — app-code projects are a handful of
		// files, so tabs keep the split to two clean panes (never a third column).
		const sourceView = div({
			display: 'none',
			flexDirection: 'column',
			flex: '0 0 auto',
			width: '50%',
			minWidth: '0',
			minHeight: '0'
		})
		const tabBar = div({
			display: 'flex',
			flex: '0 0 auto',
			minWidth: '0',
			background: '#f5f5f7',
			borderBottom: '1px solid #e3e3e6'
		})
		const tabsScroll = div({ display: 'flex', flex: '1 1 0', minWidth: '0', overflowX: 'auto' })
		const refresh = iconButton('⟳', 'Rescan project files')
		refresh.onclick = () => openProject(true)
		tabBar.append(tabsScroll, refresh)
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
		sourceView.append(tabBar, editorHost, message)

		// Drag handle between the two panes; doubles as the divider.
		const handle = div({
			display: 'none',
			flex: '0 0 auto',
			width: '5px',
			background: '#d2d2d7',
			cursor: 'col-resize'
		})

		// App view: the full live app region. No tabs, no editor or window chrome —
		// just the stable slot the devkit capability parents the live App into. Built
		// once; its children belong to the host, so we never replaceChildren it.
		const appView = div({
			display: 'flex',
			flex: '1 1 0',
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
		content.append(sourceView, handle, appView)

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

		// Drag-to-resize: pointer x within the content rect sets the code-pane
		// fraction. Clamped so neither pane collapses.
		handle.addEventListener('pointerdown', (event) => {
			event.preventDefault()
			const rect = content.getBoundingClientRect()
			const onMove = (move: PointerEvent) => {
				split = Math.min(0.85, Math.max(0.15, (move.clientX - rect.left) / rect.width))
				sourceView.style.width = `${split * 100}%`
			}
			const onUp = () => {
				window.removeEventListener('pointermove', onMove)
				window.removeEventListener('pointerup', onUp)
			}
			window.addEventListener('pointermove', onMove)
			window.addEventListener('pointerup', onUp)
		})

		const onSelect = (path: string) => {
			if (path === current.selectedPath) return
			writer.flush() // persist pending edits to the current file before switching
			void ctx.client.select({ path }).catch(() => {})
		}

		const patch = () => {
			// Toolbar state label (center)
			const badge = STATUS[statusOf(current, running)]
			stateLabel.textContent = `● ${badge.label}`
			stateLabel.style.color = badge.color

			// Code toggle + split visibility. The App stays mounted either way.
			const showCode = current.view === 'source'
			setToggle(codeToggle, showCode)
			sourceView.style.display = showCode ? 'flex' : 'none'
			sourceView.style.width = `${split * 100}%`
			handle.style.display = showCode ? 'block' : 'none'

			// File tabs
			tabsScroll.replaceChildren(
				...current.files.map((path) =>
					tabButton(
						path,
						path === current.selectedPath,
						localDirty && path === current.selectedPath,
						onSelect
					)
				)
			)

			// Editor pane: editor when the file is loaded, else a fallback message
			const ready =
				!!current.selectedPath && source.path === current.selectedPath && source.content !== null
			editorHost.style.display = ready ? '' : 'none'
			message.style.display = ready ? 'none' : ''
			if (!ready) {
				const fallback = fallbackText(current, source, loadError, projectLoaded)
				message.textContent = fallback.text
				message.style.color = fallback.error ? '#c41a16' : '#86868b'
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

function fallbackText(
	state: CodeState,
	source: SourceView,
	loadError: string | null,
	projectLoaded: boolean
): { text: string; error: boolean } {
	if (loadError) return { text: loadError, error: true }
	if (state.files.length === 0)
		return { text: projectLoaded ? 'Empty project.' : 'Loading project…', error: false }
	if (!state.selectedPath) return { text: 'Select a file to edit.', error: false }
	if (source.error) return { text: source.error, error: true }
	return { text: 'Loading…', error: false }
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

function tabButton(
	path: string,
	active: boolean,
	dirty: boolean,
	onSelect: (path: string) => void
) {
	const button = document.createElement('button')
	button.type = 'button'
	button.title = path
	button.textContent = `${dirty ? '● ' : ''}${basename(path)}`
	button.onclick = () => onSelect(path)
	Object.assign(button.style, {
		flex: '0 0 auto',
		border: '0',
		borderRight: '1px solid #e3e3e6',
		background: active ? '#ffffff' : 'transparent',
		color: active ? '#1d1d1f' : '#6e6e73',
		cursor: 'default',
		font: '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
		fontWeight: active ? '600' : '400',
		padding: '6px 12px',
		whiteSpace: 'nowrap'
	})
	return button
}

function setToggle(button: HTMLButtonElement, active: boolean) {
	button.style.background = active ? '#007aff' : '#ffffff'
	button.style.color = active ? '#ffffff' : '#1d1d1f'
	button.style.borderColor = active ? '#007aff' : '#d2d2d7'
}

function iconButton(symbol: string, title: string) {
	const button = document.createElement('button')
	button.type = 'button'
	button.textContent = symbol
	button.title = title
	Object.assign(button.style, {
		flex: '0 0 auto',
		border: '0',
		borderLeft: '1px solid #e3e3e6',
		background: 'transparent',
		color: '#6e6e73',
		cursor: 'default',
		font: 'inherit',
		fontSize: '13px',
		padding: '6px 10px'
	})
	return button
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
