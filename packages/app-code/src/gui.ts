import { defineGUI } from '@justfiles/app/browser'
import type { MenuView } from '@justfiles/app/capabilities/devkit'
import {
	type CodeApp,
	type CodeState,
	type CodeStatus,
	initialState,
	isCodeState,
	statusOf
} from './app'
import { createEditor } from './editor'
import { slugifyName } from './projects'

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

// The live editor screen, built fresh on open and torn down on close. `leave`
// runs the teardown order (block runs → await the in-flight run + drain → stop);
// `start` fires the first build once the preview slot exists in the DOM.
type EditorController = {
	el: HTMLElement
	start(): void
	update(next: CodeState): void
	leave(): Promise<void>
	destroy(): void
}

// iOS-style placeholder shown in the Dock when the project has no icon yet: a
// light-gray rounded tile with a faint generic image glyph.
const ICON_PLACEHOLDER =
	'data:image/svg+xml,' +
	encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
			`<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
			`<stop offset="0" stop-color="#ececef"/><stop offset="1" stop-color="#d4d4d9"/>` +
			`</linearGradient></defs><rect width="64" height="64" fill="url(#g)"/>` +
			`<g fill="none" stroke="#b3b3ba" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">` +
			`<rect x="18" y="18" width="28" height="28" rx="7"/><path d="M23 41l7-8 4 4 5-6 6 10"/></g>` +
			`<circle cx="27" cy="27" r="2.5" fill="#b3b3ba"/></svg>`
	)

export const gui = defineGUI<CodeApp>({
	mount(root, state, ctx) {
		let mounted = true
		let current = stateOrInitial(state)
		// The live editor (null in the gallery) and a guard so overlapping
		// open/close transitions can't race the preview lifecycle.
		let editor: EditorController | null = null
		let busy = false

		// Remembered org prefix for the New Project bundle-id prefill.
		const org = () => {
			try {
				return localStorage.getItem('app-code.org') || 'com.example'
			} catch {
				return 'com.example'
			}
		}
		const rememberOrg = (id: string) => {
			try {
				const prefix = id.split('.').slice(0, -1).join('.')
				if (prefix) localStorage.setItem('app-code.org', prefix)
			} catch {}
		}

		// --- the live editor screen, built per open ---
		const createEditorView = (initial: CodeState): EditorController => {
			let live = true
			let view = initial
			let source: SourceView = { path: null, content: null, error: null }
			let readToken = 0
			let running = false // a `run` is in flight (client-local) → drives the `Building` label
			let rerun = false // a write landed during a run → rebuild once it resolves
			let blockRuns = false // set while leaving, so no new run re-mounts the preview
			let activeRun: Promise<void> | null = null
			// `editorPath` is the file the CodeMirror buffer currently holds;
			// `localDirty` is set synchronously on the first keystroke so the tab shows
			// the dirty dot immediately (not after the debounced write lands).
			let editorPath: string | null = null
			let localDirty = false
			// Code-pane fraction of the content width; the user drags the handle to
			// resize. The App fills the rest. Only meaningful while the Code pane shows.
			let split = 0.5
			// The live App's declared menubar, pulled from devkit and drawn in the
			// preview's menubar (with the shared design CSS). `openMenu` is the open
			// dropdown index.
			let menuView: MenuView = []
			let openMenu: number | null = null

			const displayName = () => view.name || view.slug || ''

			const writer = createWriter(async (path, content) => {
				localDirty = false
				// Auto-rebuild keeps the live App current as you type: persist, then run
				// once the write resolves. `runBuild` is single-flight, so a burst of
				// edits collapses to one trailing run.
				try {
					await ctx.client.write({ path, content })
					await runBuild()
				} catch {}
			}, 1000)
			const code = createEditor((content) => {
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

			// Toolbar: [ ‹ Projects ][ </> Code ] name   ● Status   [ Install ]. Left
			// and right groups share the slack equally so the status label stays centered.
			const toolbar = div({
				display: 'flex',
				alignItems: 'center',
				gap: '8px',
				padding: '8px 12px',
				background: '#f5f5f7',
				borderBottom: '1px solid #d2d2d7'
			})
			const leftGroup = div({
				display: 'flex',
				flex: '1 1 0',
				minWidth: '0',
				alignItems: 'center',
				gap: '8px'
			})
			// Leave the project: back to the gallery. Tears down the preview first.
			const backButton = linkButton('‹ Projects')
			backButton.onclick = () => void leaveEditor()
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
				void ctx.client.setView({ view: view.view === 'source' ? 'app' : 'source' }).catch(() => {})
			// The open project's display name, so the user sees what they're editing.
			const nameLabel = div({
				fontWeight: '600',
				fontSize: '13px',
				minWidth: '0',
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
				color: '#1d1d1f'
			})
			leftGroup.append(backButton, codeToggle, nameLabel)

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
			// Shipping actions. `Pack` downloads a `.zip` others can import; `Install`
			// promotes the draft to the real /applications as a standalone app. Both
			// compile fresh in the devkit capability, so they ship the latest saved
			// source. `shipping` blocks double-fires; both drain pending edits first.
			let shipping = false
			const pack = shipButton('Pack', false)
			const install = shipButton('Install', true)

			// Run a ship action with minimal in-flight feedback: relabel while busy,
			// briefly confirm on success, surface failures in an alert (the launcher's
			// own install path does the same).
			const ship = async (
				button: HTMLButtonElement,
				busyLabel: string,
				done: string,
				run: () => Promise<void>
			) => {
				if (shipping) return
				shipping = true
				const label = button.textContent
				button.textContent = busyLabel
				patch()
				try {
					await run()
					button.textContent = done
					setTimeout(() => {
						if (!live) return
						button.textContent = label
					}, 1500)
				} catch (err) {
					button.textContent = label
					alert(messageOf(err))
				} finally {
					shipping = false
					patch()
				}
			}
			install.onclick = () =>
				void ship(install, 'Installing…', 'Installed ✓', async () => {
					await writer.drain()
					await ctx.client.install({})
				})
			pack.onclick = () =>
				void ship(pack, 'Packing…', 'Packed ✓', async () => {
					await writer.drain()
					const { zip } = await ctx.client.pack({})
					downloadZip(`${view.slug}.zip`, zip)
				})

			rightGroup.append(pack, install)
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
			refresh.onclick = () => {
				if (view.slug) void ctx.client.open({ slug: view.slug }).catch(() => {})
			}
			tabBar.append(tabsScroll, refresh)
			const editorHost = div({ flex: '1 1 auto', minHeight: '0', overflow: 'hidden' })
			editorHost.append(code.dom)
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

			// App view: always an Xcode-style mini desktop — a gray "desktop" with the OS
			// menubar on top, the live App in a floating framed window, and a Dock at the
			// bottom. app-code draws this chrome itself, reusing the OS's design-system
			// classes (`ds-menubar`, `ds-window*`, `ds-menu*`, `ds-dock*`) so it matches
			// the real UI — the host only ever hands over the running App (parented into
			// `previewSlot`) and, on request, the menu data. The Code toggle reveals the
			// Source pane beside this desktop; it never strips the chrome. Built once;
			// `previewSlot` is never re-parented, so the live App survives re-renders.
			const appView = div({
				display: 'flex',
				flexDirection: 'column',
				flex: '1 1 0',
				minWidth: '0',
				minHeight: '0',
				background: '#e8e8ed'
			})
			// Desktop menubar. `position`/`zIndex` keep its dropdowns above the desktop
			// (window + dock), which sits in its own stacking context below.
			const menubar = el('div', 'ds-menubar', {
				flex: '0 0 auto',
				position: 'relative',
				zIndex: '2'
			})
			// Region the window + dock float in; the padding is the desktop margin and
			// `position: relative` anchors the absolutely-placed dock. The larger bottom
			// padding reserves room for the dock (which doesn't consume layout) so the
			// window ends above it rather than behind it. Its own stacking context (z
			// below the menubar) keeps the window/dock under the menus.
			const desktopArea = div({
				display: 'flex',
				flex: '1 1 auto',
				minWidth: '0',
				minHeight: '0',
				position: 'relative',
				zIndex: '1',
				padding: '24px 24px 96px'
			})
			// The floating window: the OS window chrome, drawn statically and always
			// framed. `zIndex: 0` keeps any z-indexes the live App sets below the dock.
			const windowEl = el('div', 'ds-window ds-window-framed', {
				flex: '1 1 auto',
				minWidth: '0',
				minHeight: '0',
				position: 'relative',
				zIndex: '0'
			})
			windowEl.dataset.focused = 'true'
			const titlebar = el('div', 'ds-window-titlebar')
			const controls = el('div', 'ds-window-controls')
			const closeDot = el('button', 'ds-window-control ds-window-control-close')
			closeDot.type = 'button'
			closeDot.setAttribute('aria-label', 'Close')
			const fullscreenDot = el('button', 'ds-window-control ds-window-control-fullscreen')
			fullscreenDot.type = 'button'
			fullscreenDot.setAttribute('aria-label', 'Enter fullscreen')
			controls.append(closeDot, fullscreenDot)
			const windowTitle = el('span', 'ds-window-title')
			titlebar.append(controls, windowTitle, el('span', 'ds-window-spacer'))
			const windowBody = el('div', 'ds-window-body')
			const previewSlot = div({
				position: 'relative',
				flex: '1 1 auto',
				minWidth: '0',
				minHeight: '0',
				overflow: 'hidden'
			})
			previewSlot.dataset.previewSlot = ''
			windowBody.append(previewSlot)
			windowEl.append(titlebar, windowBody)

			// Dock: the live App's icon, doubling as an icon editor — click the tile to
			// upload a new icon (drag-and-drop later). Reuses the OS `ds-dock*` classes;
			// `data-editable` adds the pointer + hover camera overlay (design.css).
			const dockBar = el('div', 'ds-dock-bar')
			const dock = el('div', 'ds-dock')
			dock.setAttribute('role', 'toolbar')
			dock.setAttribute('aria-label', 'Dock')
			const dockItem = el('button', 'ds-dock-item')
			dockItem.type = 'button'
			dockItem.dataset.editable = 'true'
			dockItem.title = 'Set app icon'
			const dockIcon = el('span', 'ds-dock-icon')
			const dockImg = document.createElement('img')
			dockImg.alt = ''
			dockImg.src = ICON_PLACEHOLDER
			dockIcon.append(dockImg)
			const dockIndicator = el('span', 'ds-dock-indicator')
			dockIndicator.dataset.running = 'true' // the preview App is always live
			dockItem.append(dockIcon, dockIndicator)
			dock.append(dockItem)
			dockBar.append(dock)
			desktopArea.append(windowEl, dockBar)
			appView.append(menubar, desktopArea)
			content.append(sourceView, handle, appView)

			// Hidden picker the dock click opens; the file's bytes go to `writeIcon`
			// verbatim as a data URL, and `readIcon` reflects the saved icon back.
			const iconInput = document.createElement('input')
			iconInput.type = 'file'
			iconInput.accept = 'image/*'
			iconInput.style.display = 'none'
			const setIcon = (dataUrl: string | null) => {
				dockImg.src = dataUrl ?? ICON_PLACEHOLDER
			}
			const refreshIcon = () => {
				void ctx.client
					.readIcon({})
					.then((url) => {
						if (live) setIcon(typeof url === 'string' ? url : null)
					})
					.catch(() => {})
			}
			dockItem.onclick = () => iconInput.click()
			iconInput.onchange = () => {
				const file = iconInput.files?.[0]
				iconInput.value = '' // allow re-picking the same file
				if (!file) return
				const reader = new FileReader()
				reader.onload = () => {
					const dataUrl = String(reader.result)
					setIcon(dataUrl) // optimistic — reflect immediately
					void ctx.client.writeIcon({ dataUrl }).catch(() => {})
				}
				reader.readAsDataURL(file)
			}

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

			shell.append(toolbar, content, bottomBar, iconInput)

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
				if (path === view.selectedPath) return
				writer.flush() // persist pending edits to the current file before switching
				void ctx.client.select({ path }).catch(() => {})
			}

			// Pull the live App's declared menu and redraw the bar. Cheap and
			// idempotent; the bar is always shown, so this runs in either view.
			const refreshMenu = () => {
				void ctx.client
					.menu({})
					.then((next) => {
						if (!live) return
						menuView = Array.isArray(next) ? next : []
						if (openMenu !== null && openMenu >= menuView.length) openMenu = null
						renderMenubar()
					})
					.catch(() => {})
			}
			// Fetch now, then once more after the preview's async mount settles.
			const scheduleMenuRefresh = () => {
				refreshMenu()
				setTimeout(() => {
					if (live) refreshMenu()
				}, 400)
			}

			// Redraw the menubar from `menuView` using the design system's `ds-menu*`
			// classes, so it matches the OS bar exactly (hover/active come from CSS).
			const renderMenubar = () => {
				// App identity (bold, matching the OS bar's leading label), then the menu
				// titles packed together — the `ds-menubar` gap separates the two.
				const name = el('span', '', { fontWeight: '500', whiteSpace: 'nowrap' })
				name.textContent = displayName()
				const titles = el('div', '', { display: 'flex', alignItems: 'center' })
				menuView.forEach((group, index) => {
					const wrap = el('div', '', { position: 'relative' })
					const title = el('button', 'ds-menu-title')
					title.type = 'button'
					title.textContent = group.title
					if (openMenu === index) title.dataset.active = 'true'
					title.onclick = () => {
						openMenu = openMenu === index ? null : index
						if (openMenu !== null) refreshMenu() // freshen checked/disabled before showing
						renderMenubar()
					}
					title.onpointerenter = () => {
						if (openMenu !== null && openMenu !== index) {
							openMenu = index
							renderMenubar()
						}
					}
					wrap.append(title)
					if (openMenu === index) wrap.append(renderDropdown(group, index))
					titles.append(wrap)
				})
				menubar.replaceChildren(name, titles)
			}

			const renderDropdown = (group: MenuView[number], menuIndex: number) => {
				const dropdown = el('div', 'ds-menu', {
					position: 'absolute',
					left: '0',
					top: '100%',
					marginTop: '1px',
					zIndex: '10000'
				})
				dropdown.setAttribute('role', 'menu')
				group.items.forEach((item, itemIndex) => {
					if ('separator' in item) {
						dropdown.append(el('div', 'ds-menu-separator'))
						return
					}
					const row = el('button', 'ds-menu-item')
					row.type = 'button'
					row.setAttribute('role', 'menuitem')
					if (item.disabled) {
						row.disabled = true
						row.setAttribute('aria-disabled', 'true')
					}
					const check = el('span', '', { width: '16px', flex: '0 0 auto' })
					check.textContent = item.checked ? '✓' : ''
					const label = el('span', '', { flex: '1 1 auto' })
					label.textContent = item.title
					row.append(check, label)
					if (item.shortcut) {
						const shortcut = el('span', '', {
							marginLeft: 'auto',
							paddingLeft: '24px',
							opacity: '0.6'
						})
						shortcut.textContent = item.shortcut
						row.append(shortcut)
					}
					if (!item.disabled) {
						row.onclick = () => {
							openMenu = null
							renderMenubar()
							void ctx.client
								.selectMenu({ menu: menuIndex, item: itemIndex })
								.then(() => setTimeout(() => live && refreshMenu(), 50))
								.catch(() => {})
						}
					}
					dropdown.append(row)
				})
				return dropdown
			}

			// Dismiss an open menu on outside click / Escape.
			const onDocPointerDown = (event: PointerEvent) => {
				if (openMenu === null || menubar.contains(event.target as Node)) return
				openMenu = null
				renderMenubar()
			}
			const onDocKey = (event: KeyboardEvent) => {
				if (openMenu === null || event.key !== 'Escape') return
				openMenu = null
				renderMenubar()
			}
			window.addEventListener('pointerdown', onDocPointerDown, true)
			window.addEventListener('keydown', onDocKey, true)

			const patch = () => {
				// Toolbar state label (center) + project name (left)
				const badge = STATUS[statusOf(view, running)]
				stateLabel.textContent = `● ${badge.label}`
				stateLabel.style.color = badge.color
				nameLabel.textContent = displayName()

				// Ship buttons: enabled unless a ship is in flight. A broken build still
				// lets you try — the capability compiles and errors.
				const canShip = !shipping
				for (const button of [install, pack]) {
					button.disabled = !canShip
					button.style.opacity = canShip ? '1' : '0.4'
				}

				// Code toggle + Source-pane visibility. The mini-desktop chrome (menubar,
				// framed window, dock, backdrop) is always on; only the Source pane and
				// its drag handle appear/disappear with the toggle. The App stays mounted
				// either way.
				const showCode = view.view === 'source'
				setToggle(codeToggle, showCode)
				sourceView.style.display = showCode ? 'flex' : 'none'
				sourceView.style.width = `${split * 100}%`
				handle.style.display = showCode ? 'block' : 'none'

				windowTitle.textContent = displayName()
				renderMenubar()

				// File tabs
				tabsScroll.replaceChildren(
					...view.files.map((path) =>
						tabButton(
							path,
							path === view.selectedPath,
							localDirty && path === view.selectedPath,
							onSelect
						)
					)
				)

				// Editor pane: editor when the file is loaded, else a fallback message
				const ready =
					!!view.selectedPath && source.path === view.selectedPath && source.content !== null
				editorHost.style.display = ready ? '' : 'none'
				message.style.display = ready ? 'none' : ''
				if (!ready) {
					const fallback = fallbackText(view, source)
					message.textContent = fallback.text
					message.style.color = fallback.error ? '#c41a16' : '#86868b'
				}

				// Bottom message area
				const build = view.build
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
			// `activeRun` exposes the in-flight chain so `leave` can await it before
			// stopping; `blockRuns` gates new runs once we start leaving.
			const runBuild = (): Promise<void> => {
				if (blockRuns) return activeRun ?? Promise.resolve()
				if (running) {
					rerun = true
					return activeRun ?? Promise.resolve()
				}
				running = true
				patch()
				activeRun = (async () => {
					try {
						await ctx.client.run({})
					} catch {
					} finally {
						running = false
						if (rerun && !blockRuns) {
							rerun = false
							await runBuild()
						} else {
							patch()
							scheduleMenuRefresh() // the App may have re-mounted with new menus
						}
					}
				})()
				return activeRun
			}

			const syncSource = () => {
				const path = view.selectedPath
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
						if (!live || token !== readToken) return
						source = { path, content, error: null }
						editorPath = path
						localDirty = false
						code.setDoc(content)
						patch()
					})
					.catch((err) => {
						if (!live || token !== readToken) return
						source = { path, content: null, error: messageOf(err) }
						patch()
					})
			}

			return {
				el: shell,
				start() {
					patch()
					syncSource()
					refreshIcon()
					void runBuild() // first build now that the preview slot exists
					scheduleMenuRefresh()
				},
				update(next) {
					view = next
					syncSource()
					patch()
				},
				// Teardown order before leaving: stop new runs, let the in-flight run
				// settle (else it re-mounts the preview after we stop), drain pending
				// writes (so a late save can't land in the next project), then stop.
				async leave() {
					blockRuns = true
					if (activeRun) await activeRun.catch(() => {})
					await writer.drain()
					await ctx.client.stop({}).catch(() => {})
				},
				destroy() {
					live = false
					readToken++
					window.removeEventListener('pointerdown', onDocPointerDown, true)
					window.removeEventListener('keydown', onDocKey, true)
					writer.flush() // persist the last in-flight edit on close
					code.destroy()
				}
			}
		}

		// --- gallery + new project (full-window screens, capped + centered) ---
		const showGallery = async () => {
			let projects: { slug: string; name: string }[] = []
			try {
				projects = await ctx.client.listProjects({})
			} catch {}
			if (!mounted || editor) return
			root.replaceChildren(galleryView(projects))
		}

		const galleryView = (projects: { slug: string; name: string }[]) => {
			const { outer, inner } = screenWrap()
			const head = div({
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				marginBottom: '20px'
			})
			const title = div({ fontSize: '20px', fontWeight: '650' })
			title.textContent = 'Projects'
			const newBtn = primaryButton('+ New Project')
			newBtn.onclick = () => showNewProject()
			head.append(title, newBtn)
			inner.append(head)

			if (projects.length === 0) {
				const empty = div({ textAlign: 'center', padding: '48px 16px' })
				const h = div({ fontSize: '16px', fontWeight: '600' })
				h.textContent = 'No projects yet'
				const p = div({ color: '#6e6e73', margin: '6px 0 18px' })
				p.textContent = 'Create your first app to get started.'
				const cta = primaryButton('+ New Project')
				cta.onclick = () => showNewProject()
				empty.append(h, p, cta)
				inner.append(empty)
				return outer
			}

			// Names-only rows; show the muted bundle id only when names collide.
			const counts = new Map<string, number>()
			for (const proj of projects) counts.set(proj.name, (counts.get(proj.name) ?? 0) + 1)
			const list = div({ border: '1px solid #e3e3e6', borderRadius: '10px', overflow: 'hidden' })
			projects.forEach((proj, i) => {
				const row = div({
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '11px 14px',
					cursor: 'default',
					borderTop: i === 0 ? '0' : '1px solid #e3e3e6'
				})
				const nameWrap = div({ display: 'flex', flexDirection: 'column', minWidth: '0' })
				const nm = div({ fontWeight: '600', fontSize: '14px' })
				nm.textContent = proj.name
				nameWrap.append(nm)
				if ((counts.get(proj.name) ?? 0) > 1) {
					const sub = div({ fontSize: '12px', color: '#a1a1a6' })
					sub.textContent = proj.slug
					nameWrap.append(sub)
				}
				const chev = div({ color: '#c7c7cc', fontSize: '16px' })
				chev.textContent = '›'
				row.append(nameWrap, chev)
				row.onclick = () => void openProject(proj.slug)
				row.onpointerenter = () => {
					row.style.background = '#f5f5f7'
				}
				row.onpointerleave = () => {
					row.style.background = 'transparent'
				}
				list.append(row)
			})
			inner.append(list)
			return outer
		}

		const showNewProject = () => {
			if (editor) return
			root.replaceChildren(newProjectView())
		}

		const newProjectView = () => {
			const { outer, inner } = screenWrap()
			const head = div({
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				marginBottom: '20px'
			})
			const cancel = linkButton('‹ Cancel')
			cancel.onclick = () => void showGallery()
			const ttl = div({ fontWeight: '650', fontSize: '16px' })
			ttl.textContent = 'New Project'
			const createBtn = primaryButton('Create')
			head.append(cancel, ttl, createBtn)

			const name = field('Name')
			const id = field('Bundle Identifier')
			const hint = div({
				fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
				fontSize: '12px',
				color: '#a1a1a6',
				marginTop: '6px'
			})
			id.wrap.append(hint)
			const error = div({ fontSize: '13px', color: '#c41a16', minHeight: '18px', marginTop: '4px' })

			let idEdited = false
			const updateHint = () => {
				hint.textContent = `Folder: /projects/${id.input.value} · must be unique`
			}
			name.input.oninput = () => {
				if (!idEdited) id.input.value = `${org()}.${slugifyName(name.input.value)}`
				updateHint()
			}
			id.input.oninput = () => {
				idEdited = true
				updateHint()
			}
			id.input.value = `${org()}.app`
			updateHint()

			const submit = async () => {
				const projectName = name.input.value.trim()
				const projectId = id.input.value.trim()
				error.textContent = ''
				if (!projectName) {
					error.textContent = 'Name is required.'
					return
				}
				createBtn.disabled = true
				try {
					const created = await ctx.client.create({
						name: projectName,
						id: projectId,
						template: 'react'
					})
					rememberOrg(projectId)
					await openProject(created.slug)
				} catch (err) {
					if (!mounted) return
					createBtn.disabled = false
					error.textContent = messageOf(err)
				}
			}
			createBtn.onclick = () => void submit()
			const onEnter = (event: KeyboardEvent) => {
				if (event.key === 'Enter') void submit()
			}
			name.input.addEventListener('keydown', onEnter)
			id.input.addEventListener('keydown', onEnter)

			inner.append(head, name.wrap, id.wrap, error)
			queueMicrotask(() => name.input.focus())
			return outer
		}

		// --- navigation: open is load-then-run; leave/open tear down + remount ---
		const openProject = async (slug: string) => {
			if (busy) return
			busy = true
			try {
				const next = await ctx.client.open({ slug }) // load only (no build yet)
				if (!mounted) return
				current = stateOrInitial(next)
				const view = createEditorView(current)
				editor = view
				root.replaceChildren(view.el) // the preview slot now exists in the DOM
				view.start() // …so the first build can mount into it
			} catch (err) {
				if (!mounted) return
				alert(messageOf(err))
				await showGallery()
			} finally {
				busy = false
			}
		}

		const leaveEditor = async () => {
			if (busy || !editor) return
			busy = true
			const view = editor
			editor = null // so kernel pushes during teardown don't re-render the editor
			try {
				await view.leave() // block runs → await run + drain → stop
				await ctx.client.close({}).catch(() => {}) // slug → null, drops the watch
				view.destroy()
				current = stateOrInitial(null)
			} finally {
				busy = false
			}
			await showGallery()
		}

		const update = (next: CodeState | null) => {
			current = stateOrInitial(next)
			editor?.update(current)
		}

		// Always launch into the gallery: drop any persisted open project, then list.
		void (async () => {
			await ctx.client.close({}).catch(() => {})
			if (!mounted) return
			current = stateOrInitial(null)
			await showGallery()
		})()

		return {
			update,
			unmount() {
				mounted = false
				editor?.destroy()
				editor = null
				root.replaceChildren()
			}
		}
	}
})

function fallbackText(state: CodeState, source: SourceView): { text: string; error: boolean } {
	if (state.files.length === 0) return { text: 'Empty project.', error: false }
	if (!state.selectedPath) return { text: 'Select a file to edit.', error: false }
	if (source.error) return { text: source.error, error: true }
	return { text: 'Loading…', error: false }
}

// Debounced, path-aware file writer. Coalesces rapid edits to one file; if the
// edited path changes (the user switched files) the pending write fires first
// so no buffer is lost. `drain` flushes then awaits the in-flight write, so an
// action that leaves the project can be sure the freshest bytes are saved.
function createWriter(write: (path: string, content: string) => Promise<void>, ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined
	let pending: { path: string; content: string } | null = null
	let inflight: Promise<void> = Promise.resolve()
	const fire = () => {
		if (timer) {
			clearTimeout(timer)
			timer = undefined
		}
		if (!pending) return
		const { path, content } = pending
		pending = null
		inflight = write(path, content)
	}
	return {
		push(path: string, content: string) {
			if (pending && pending.path !== path) fire()
			pending = { path, content }
			if (timer) clearTimeout(timer)
			timer = setTimeout(fire, ms)
		},
		flush: fire,
		async drain() {
			fire()
			await inflight.catch(() => {})
		}
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

// A toolbar shipping button: `primary` is the filled blue Install; otherwise a
// bordered secondary (Pack).
function shipButton(label: string, primary: boolean) {
	const button = document.createElement('button')
	button.type = 'button'
	button.textContent = label
	Object.assign(button.style, {
		flex: '0 0 auto',
		marginLeft: '8px',
		background: primary ? '#007aff' : '#ffffff',
		border: primary ? '0' : '1px solid #d2d2d7',
		borderRadius: '6px',
		color: primary ? '#ffffff' : '#1d1d1f',
		cursor: 'default',
		font: 'inherit',
		fontSize: '12px',
		fontWeight: '600',
		padding: primary ? '5px 14px' : '5px 12px'
	})
	return button
}

// A filled-blue primary button for the gallery / form screens.
function primaryButton(label: string) {
	const button = document.createElement('button')
	button.type = 'button'
	button.textContent = label
	Object.assign(button.style, {
		flex: '0 0 auto',
		border: '0',
		borderRadius: '6px',
		background: '#007aff',
		color: '#ffffff',
		cursor: 'default',
		font: 'inherit',
		fontSize: '13px',
		fontWeight: '600',
		padding: '7px 14px'
	})
	return button
}

// A borderless muted button for back / cancel affordances.
function linkButton(label: string) {
	const button = document.createElement('button')
	button.type = 'button'
	button.textContent = label
	Object.assign(button.style, {
		flex: '0 0 auto',
		border: '0',
		background: 'transparent',
		color: '#6e6e73',
		cursor: 'default',
		font: 'inherit',
		fontSize: '13px',
		fontWeight: '600',
		padding: '5px 4px',
		whiteSpace: 'nowrap'
	})
	return button
}

// A capped-width, centered, scrollable screen container (gallery / forms), so a
// window left wide from the editor still reads well.
function screenWrap() {
	const outer = div({
		flex: '1 1 auto',
		overflow: 'auto',
		background: '#ffffff',
		color: '#1d1d1f',
		fontFamily: 'var(--font-ui)',
		padding: '32px 20px'
	})
	const inner = div({ maxWidth: '560px', margin: '0 auto', width: '100%' })
	outer.append(inner)
	return { outer, inner }
}

// A labelled text field for the form screens.
function field(label: string) {
	const wrap = div({ margin: '0 0 16px' })
	const lab = document.createElement('label')
	Object.assign(lab.style, {
		display: 'block',
		fontSize: '12px',
		color: '#6e6e73',
		marginBottom: '6px'
	})
	lab.textContent = label
	const input = document.createElement('input')
	input.type = 'text'
	Object.assign(input.style, {
		width: '100%',
		font: 'inherit',
		fontSize: '14px',
		padding: '8px 10px',
		border: '1px solid #d2d2d7',
		borderRadius: '7px',
		background: '#ffffff',
		color: '#1d1d1f',
		boxSizing: 'border-box'
	})
	wrap.append(lab, input)
	return { wrap, input }
}

// Turn the packed zip bytes into a browser file download. Copy into a plain
// ArrayBuffer so the Blob part type is satisfied regardless of the source view.
function downloadZip(name: string, zip: Uint8Array) {
	const buffer = new ArrayBuffer(zip.byteLength)
	new Uint8Array(buffer).set(zip)
	const url = URL.createObjectURL(new Blob([buffer], { type: 'application/zip' }))
	const anchor = document.createElement('a')
	anchor.href = url
	anchor.download = name
	anchor.click()
	setTimeout(() => URL.revokeObjectURL(url), 1000)
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

// Element with a class (for the shared design-system classes) and optional
// inline layout styles.
function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className: string,
	style?: Partial<CSSStyleDeclaration>
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag)
	element.className = className
	if (style) Object.assign(element.style, style)
	return element
}
