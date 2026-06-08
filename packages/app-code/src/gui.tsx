import type { Client } from '@justfiles/app'
import { defineGUI } from '@justfiles/app/browser'
import type { MenuView } from '@justfiles/app/capabilities/devkit'
import {
	type CSSProperties,
	type FormEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	StrictMode,
	useEffect,
	useMemo,
	useRef,
	useState
} from 'react'
import { createRoot } from 'react-dom/client'
import {
	type CodeApp,
	type CodeState,
	type CodeStatus,
	initialState,
	isCodeState,
	statusOf
} from './app'
import { createEditor, type Editor } from './editor'
import { slugifyName } from './projects'

const stateOrInitial = (value: unknown): CodeState => (isCodeState(value) ? value : initialState)

const STATUS: Record<CodeStatus, { label: string; color: string }> = {
	idle: { label: 'Idle', color: '#86868b' },
	updating: { label: 'Updating', color: '#6e8efb' },
	building: { label: 'Building', color: '#007aff' },
	live: { label: 'Live', color: '#1aa251' },
	'needs-fixes': { label: 'Needs fixes', color: '#d9822b' },
	crashed: { label: 'Crashed', color: '#c41a16' }
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'

type Project = { slug: string; name: string }

type SourceView = {
	path: string | null
	content: string | null
	error: string | null
}

type EditorController = {
	start(): void
	render(): void
	update(next: CodeState): void
	leave(): Promise<void>
	destroy(): void
}

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
	mount(root, _state, ctx) {
		const reactRoot = createRoot(root)
		let mounted = true
		let editor: EditorController | null = null
		let busy = false

		const render = (node: ReactNode) => {
			if (!mounted) return
			reactRoot.render(<StrictMode>{node}</StrictMode>)
		}

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

		const showGallery = async () => {
			let projects: Project[] = []
			try {
				projects = await ctx.client.listProjects({})
			} catch {}
			if (!mounted || editor) return
			render(
				<GalleryScreen
					projects={projects}
					onNew={showNewProject}
					onOpen={(slug) => void openProject(slug)}
				/>
			)
		}

		const showNewProject = () => {
			if (editor) return
			render(
				<NewProjectScreen
					client={ctx.client}
					org={org}
					rememberOrg={rememberOrg}
					onCancel={() => void showGallery()}
					onCreated={openProject}
				/>
			)
		}

		const createEditorView = (initial: CodeState): EditorController => {
			let live = true
			let started = false
			let view = initial
			let source: SourceView = { path: null, content: null, error: null }
			let readToken = 0
			let running = false
			let rerun = false
			let blockRuns = false
			let activeRun: Promise<void> | null = null
			let editorPath: string | null = null
			let localDirty = false
			let split = 0.5
			let menuView: MenuView = []
			let openMenu: number | null = null
			let shipping = false
			let packLabel = 'Pack'
			let installLabel = 'Install'
			let iconUrl: string | null = null
			let menubarEl: HTMLElement | null = null
			let sourceViewEl: HTMLElement | null = null
			let contentEl: HTMLElement | null = null

			const displayName = () => view.name || view.slug || ''

			const writer = createWriter(async (path, content) => {
				localDirty = false
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

			const setOpenMenu = (next: number | null) => {
				openMenu = next
				patch()
			}
			const refreshMenu = () => {
				void ctx.client
					.menu({})
					.then((next) => {
						if (!live) return
						menuView = Array.isArray(next) ? next : []
						if (openMenu !== null && openMenu >= menuView.length) openMenu = null
						patch()
					})
					.catch(() => {})
			}
			const scheduleMenuRefresh = () => {
				refreshMenu()
				setTimeout(() => {
					if (live) refreshMenu()
				}, 400)
			}

			const refreshIcon = () => {
				void ctx.client
					.readIcon({})
					.then((url) => {
						if (!live) return
						iconUrl = typeof url === 'string' ? url : null
						patch()
					})
					.catch(() => {})
			}

			const ship = async (
				kind: 'pack' | 'install',
				busyLabel: string,
				done: string,
				run: () => Promise<void>
			) => {
				if (shipping) return
				shipping = true
				const label = kind === 'pack' ? packLabel : installLabel
				if (kind === 'pack') packLabel = busyLabel
				else installLabel = busyLabel
				patch()
				try {
					await run()
					if (kind === 'pack') packLabel = done
					else installLabel = done
					setTimeout(() => {
						if (!live) return
						if (kind === 'pack') packLabel = label
						else installLabel = label
						patch()
					}, 1500)
				} catch (err) {
					if (kind === 'pack') packLabel = label
					else installLabel = label
					alert(messageOf(err))
				} finally {
					shipping = false
					patch()
				}
			}

			const install = () =>
				void ship('install', 'Installing…', 'Installed ✓', async () => {
					await writer.drain()
					await ctx.client.install({})
				})
			const pack = () =>
				void ship('pack', 'Packing…', 'Packed ✓', async () => {
					await writer.drain()
					const { zip } = await ctx.client.pack({})
					downloadZip(`${view.slug}.zip`, zip)
				})

			const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
				event.preventDefault()
				const rect = contentEl?.getBoundingClientRect()
				if (!rect) return
				const onMove = (move: PointerEvent) => {
					split = Math.min(0.85, Math.max(0.15, (move.clientX - rect.left) / rect.width))
					if (sourceViewEl) sourceViewEl.style.width = `${split * 100}%`
				}
				const onUp = () => {
					window.removeEventListener('pointermove', onMove)
					window.removeEventListener('pointerup', onUp)
				}
				window.addEventListener('pointermove', onMove)
				window.addEventListener('pointerup', onUp)
			}

			const selectPath = (path: string) => {
				if (path === view.selectedPath) return
				writer.flush()
				void ctx.client.select({ path }).catch(() => {})
			}

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
							scheduleMenuRefresh()
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

			const onDocPointerDown = (event: PointerEvent) => {
				if (openMenu === null || menubarEl?.contains(event.target as Node)) return
				openMenu = null
				patch()
			}
			const onDocKey = (event: KeyboardEvent) => {
				if (openMenu === null || event.key !== 'Escape') return
				openMenu = null
				patch()
			}
			window.addEventListener('pointerdown', onDocPointerDown, true)
			window.addEventListener('keydown', onDocKey, true)

			const props = (): EditorScreenProps => {
				const badge = STATUS[statusOf(view, running)]
				return {
					view,
					source,
					code,
					badge,
					name: displayName(),
					localDirty,
					split,
					menuView,
					openMenu,
					shipping,
					packLabel,
					installLabel,
					iconUrl,
					onStart: controller.start,
					onBack: () => void leaveEditor(),
					onToggleCode: () =>
						void ctx.client
							.setView({ view: view.view === 'source' ? 'app' : 'source' })
							.catch(() => {}),
					onRefresh: () => {
						if (view.slug) void ctx.client.open({ slug: view.slug }).catch(() => {})
					},
					onSelectPath: selectPath,
					onInstall: install,
					onPack: pack,
					onDrag: startDrag,
					onIconFile: (file) => {
						const reader = new FileReader()
						reader.onload = () => {
							const dataUrl = String(reader.result)
							iconUrl = dataUrl
							patch()
							void ctx.client.writeIcon({ dataUrl }).catch(() => {})
						}
						reader.readAsDataURL(file)
					},
					onToggleMenu: (index) => {
						openMenu = openMenu === index ? null : index
						if (openMenu !== null) refreshMenu()
						patch()
					},
					onEnterMenu: (index) => {
						if (openMenu !== null && openMenu !== index) setOpenMenu(index)
					},
					onSelectMenu: (menu, item) => {
						openMenu = null
						patch()
						void ctx.client
							.selectMenu({ menu, item })
							.then(() => setTimeout(() => live && refreshMenu(), 50))
							.catch(() => {})
					},
					setMenubar: (el) => {
						menubarEl = el
					},
					setSourceView: (el) => {
						sourceViewEl = el
					},
					setContent: (el) => {
						contentEl = el
					}
				}
			}

			const patch = () => {
				if (live) render(<EditorScreen {...props()} />)
			}

			const controller: EditorController = {
				start() {
					if (started || !live) return
					started = true
					patch()
					syncSource()
					refreshIcon()
					void runBuild()
					scheduleMenuRefresh()
				},
				render: patch,
				update(next) {
					view = next
					syncSource()
					patch()
				},
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
					writer.flush()
					code.destroy()
				}
			}

			return controller
		}

		const openProject = async (slug: string) => {
			if (busy) return
			busy = true
			try {
				const next = await ctx.client.open({ slug })
				if (!mounted) return
				const view = createEditorView(stateOrInitial(next))
				editor = view
				view.render()
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
			editor = null
			try {
				await view.leave()
				await ctx.client.close({}).catch(() => {})
				view.destroy()
			} finally {
				busy = false
			}
			await showGallery()
		}

		void (async () => {
			await ctx.client.close({}).catch(() => {})
			if (mounted) await showGallery()
		})()

		return {
			update(next) {
				editor?.update(stateOrInitial(next))
			},
			unmount() {
				mounted = false
				editor?.destroy()
				editor = null
				reactRoot.unmount()
			}
		}
	}
})

type EditorScreenProps = {
	view: CodeState
	source: SourceView
	code: Editor
	badge: { label: string; color: string }
	name: string
	localDirty: boolean
	split: number
	menuView: MenuView
	openMenu: number | null
	shipping: boolean
	packLabel: string
	installLabel: string
	iconUrl: string | null
	onStart: () => void
	onBack: () => void
	onToggleCode: () => void
	onRefresh: () => void
	onSelectPath: (path: string) => void
	onInstall: () => void
	onPack: () => void
	onDrag: (event: ReactPointerEvent<HTMLDivElement>) => void
	onIconFile: (file: File) => void
	onToggleMenu: (index: number) => void
	onEnterMenu: (index: number) => void
	onSelectMenu: (menu: number, item: number) => void
	setMenubar: (el: HTMLDivElement | null) => void
	setSourceView: (el: HTMLDivElement | null) => void
	setContent: (el: HTMLDivElement | null) => void
}

function EditorScreen(props: EditorScreenProps) {
	const iconInput = useRef<HTMLInputElement>(null)
	useEffect(() => props.onStart(), [props.onStart])
	const showCode = props.view.view === 'source'
	const ready =
		!!props.view.selectedPath &&
		props.source.path === props.view.selectedPath &&
		props.source.content !== null
	const fallback = ready ? null : fallbackText(props.view, props.source)
	const build = props.view.build

	return (
		<div style={styles.shell}>
			<div style={styles.toolbar}>
				<div style={styles.toolbarSide}>
					<LinkButton label="‹ Projects" onClick={props.onBack} />
					<button type="button" onClick={props.onToggleCode} style={codeToggleStyle(showCode)}>
						{'</> Code'}
					</button>
					<div style={styles.nameLabel}>{props.name}</div>
				</div>
				<div style={{ ...styles.stateLabel, color: props.badge.color }}>● {props.badge.label}</div>
				<div style={styles.rightGroup}>
					<ShipButton
						label={props.packLabel}
						disabled={props.shipping}
						primary={false}
						onClick={props.onPack}
					/>
					<ShipButton
						label={props.installLabel}
						disabled={props.shipping}
						primary
						onClick={props.onInstall}
					/>
				</div>
			</div>

			<div ref={props.setContent} style={styles.content}>
				<div
					ref={props.setSourceView}
					style={{
						...styles.sourceView,
						display: showCode ? 'flex' : 'none',
						width: `${props.split * 100}%`
					}}
				>
					<div style={styles.tabBar}>
						<div style={styles.tabsScroll}>
							{props.view.files.map((path) => (
								<TabButton
									key={path}
									path={path}
									active={path === props.view.selectedPath}
									dirty={props.localDirty && path === props.view.selectedPath}
									onSelect={props.onSelectPath}
								/>
							))}
						</div>
						<IconButton label="⟳" title="Rescan project files" onClick={props.onRefresh} />
					</div>
					<CodeMirrorHost editor={props.code} ready={ready} />
					<pre
						style={{
							...styles.message,
							display: ready ? 'none' : '',
							color: fallback?.error ? '#c41a16' : '#86868b'
						}}
					>
						{fallback?.text ?? ''}
					</pre>
				</div>

				<div
					style={{ ...styles.handle, display: showCode ? 'block' : 'none' }}
					onPointerDown={props.onDrag}
				/>

				<div style={styles.appView}>
					<Menubar
						name={props.name}
						menuView={props.menuView}
						openMenu={props.openMenu}
						onToggle={props.onToggleMenu}
						onEnter={props.onEnterMenu}
						onSelect={props.onSelectMenu}
						setRef={props.setMenubar}
					/>
					<div style={styles.desktopArea}>
						<div className="ds-window ds-window-framed" data-focused="true" style={styles.windowEl}>
							<div className="ds-window-titlebar">
								<div className="ds-window-controls">
									<button
										type="button"
										className="ds-window-control ds-window-control-close"
										aria-label="Close"
									/>
									<button
										type="button"
										className="ds-window-control ds-window-control-fullscreen"
										aria-label="Enter fullscreen"
									/>
								</div>
								<span className="ds-window-title">{props.name}</span>
								<span className="ds-window-spacer" />
							</div>
							<div className="ds-window-body">
								<div data-preview-slot="" style={styles.previewSlot} />
							</div>
						</div>

						<div className="ds-dock-bar">
							<div className="ds-dock" role="toolbar" aria-label="Dock">
								<button
									type="button"
									className="ds-dock-item"
									data-editable="true"
									title="Set app icon"
									onClick={() => iconInput.current?.click()}
								>
									<span className="ds-dock-icon">
										<img alt="" src={props.iconUrl ?? ICON_PLACEHOLDER} />
									</span>
									<span className="ds-dock-indicator" data-running="true" />
								</button>
							</div>
						</div>
					</div>
				</div>
			</div>

			<div style={{ ...styles.bottomBar, display: build ? 'flex' : 'none' }}>
				<div
					style={{
						fontSize: '12px',
						whiteSpace: 'pre-wrap',
						color: build?.result === 'ok' ? '#1aa251' : '#c41a16'
					}}
				>
					{build?.message ?? ''}
				</div>
				<pre
					style={{
						...styles.diagnostics,
						display: build && build.diagnostics.length > 0 ? '' : 'none'
					}}
				>
					{build?.diagnostics.join('\n') ?? ''}
				</pre>
			</div>

			<input
				ref={iconInput}
				type="file"
				accept="image/*"
				style={{ display: 'none' }}
				onChange={(event) => {
					const input = event.currentTarget
					const file = input.files?.[0]
					input.value = ''
					if (file) props.onIconFile(file)
				}}
			/>
		</div>
	)
}

function Menubar(props: {
	name: string
	menuView: MenuView
	openMenu: number | null
	onToggle: (index: number) => void
	onEnter: (index: number) => void
	onSelect: (menu: number, item: number) => void
	setRef: (el: HTMLDivElement | null) => void
}) {
	return (
		<div ref={props.setRef} className="ds-menubar" style={styles.menubar}>
			<span style={{ fontWeight: '500', whiteSpace: 'nowrap' }}>{props.name}</span>
			<div style={{ display: 'flex', alignItems: 'center' }}>
				{props.menuView.map((group, index) => (
					<div key={group.title} style={{ position: 'relative' }}>
						<button
							type="button"
							className="ds-menu-title"
							data-active={props.openMenu === index ? 'true' : undefined}
							onClick={() => props.onToggle(index)}
							onPointerEnter={() => props.onEnter(index)}
						>
							{group.title}
						</button>
						{props.openMenu === index ? (
							<MenuDropdown group={group} menuIndex={index} onSelect={props.onSelect} />
						) : null}
					</div>
				))}
			</div>
		</div>
	)
}

function MenuDropdown(props: {
	group: MenuView[number]
	menuIndex: number
	onSelect: (menu: number, item: number) => void
}) {
	const items = props.group.items.map((item, itemIndex) => ({
		item,
		itemIndex,
		key: 'separator' in item ? `separator:${itemIndex}` : `${item.title}:${item.shortcut ?? ''}`
	}))
	return (
		<div className="ds-menu" role="menu" style={styles.dropdown}>
			{items.map(({ item, itemIndex, key }) => {
				if ('separator' in item) return <div key={key} className="ds-menu-separator" />
				return (
					<button
						key={key}
						type="button"
						className="ds-menu-item"
						role="menuitem"
						disabled={item.disabled}
						aria-disabled={item.disabled ? 'true' : undefined}
						onClick={item.disabled ? undefined : () => props.onSelect(props.menuIndex, itemIndex)}
					>
						<span style={{ width: '16px', flex: '0 0 auto' }}>{item.checked ? '✓' : ''}</span>
						<span style={{ flex: '1 1 auto' }}>{item.title}</span>
						{item.shortcut ? (
							<span style={{ marginLeft: 'auto', paddingLeft: '24px', opacity: '0.6' }}>
								{item.shortcut}
							</span>
						) : null}
					</button>
				)
			})}
		</div>
	)
}

function CodeMirrorHost({ editor, ready }: { editor: Editor; ready: boolean }) {
	const ref = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const host = ref.current
		if (!host) return
		host.append(editor.dom)
		return () => {
			if (editor.dom.parentElement === host) host.removeChild(editor.dom)
		}
	}, [editor])
	return <div ref={ref} style={{ ...styles.editorHost, display: ready ? '' : 'none' }} />
}

function GalleryScreen(props: {
	projects: Project[]
	onNew: () => void
	onOpen: (slug: string) => void
}) {
	const counts = useMemo(() => {
		const next = new Map<string, number>()
		for (const project of props.projects) next.set(project.name, (next.get(project.name) ?? 0) + 1)
		return next
	}, [props.projects])

	return (
		<ScreenWrap>
			<div style={styles.galleryHead}>
				<div style={{ fontSize: '20px', fontWeight: '650' }}>Projects</div>
				<PrimaryButton label="+ New Project" onClick={props.onNew} />
			</div>
			{props.projects.length === 0 ? (
				<div style={{ textAlign: 'center', padding: '48px 16px' }}>
					<div style={{ fontSize: '16px', fontWeight: '600' }}>No projects yet</div>
					<div style={{ color: '#6e6e73', margin: '6px 0 18px' }}>
						Create your first app to get started.
					</div>
					<PrimaryButton label="+ New Project" onClick={props.onNew} />
				</div>
			) : (
				<div style={styles.projectList}>
					{props.projects.map((project, index) => (
						<ProjectRow
							key={project.slug}
							project={project}
							duplicate={(counts.get(project.name) ?? 0) > 1}
							first={index === 0}
							onOpen={props.onOpen}
						/>
					))}
				</div>
			)}
		</ScreenWrap>
	)
}

function ProjectRow(props: {
	project: Project
	duplicate: boolean
	first: boolean
	onOpen: (slug: string) => void
}) {
	return (
		<button
			type="button"
			onClick={() => props.onOpen(props.project.slug)}
			onPointerEnter={(event) => {
				event.currentTarget.style.background = '#f5f5f7'
			}}
			onPointerLeave={(event) => {
				event.currentTarget.style.background = 'transparent'
			}}
			style={{
				...styles.projectRow,
				width: '100%',
				background: 'transparent',
				border: '0',
				borderTop: props.first ? '0' : '1px solid #e3e3e6',
				color: 'inherit',
				font: 'inherit',
				textAlign: 'left'
			}}
		>
			<div style={{ display: 'flex', flexDirection: 'column', minWidth: '0' }}>
				<div style={{ fontWeight: '600', fontSize: '14px' }}>{props.project.name}</div>
				{props.duplicate ? (
					<div style={{ fontSize: '12px', color: '#a1a1a6' }}>{props.project.slug}</div>
				) : null}
			</div>
			<div style={{ color: '#c7c7cc', fontSize: '16px' }}>›</div>
		</button>
	)
}

function NewProjectScreen(props: {
	client: Client<CodeApp>
	org: () => string
	rememberOrg: (id: string) => void
	onCancel: () => void
	onCreated: (slug: string) => Promise<void>
}) {
	const nameRef = useRef<HTMLInputElement>(null)
	const [name, setName] = useState('')
	const [id, setId] = useState(() => `${props.org()}.app`)
	const [idEdited, setIdEdited] = useState(false)
	const [error, setError] = useState('')
	const [creating, setCreating] = useState(false)
	useEffect(() => nameRef.current?.focus(), [])

	const submit = async (event: FormEvent) => {
		event.preventDefault()
		const projectName = name.trim()
		const projectId = id.trim()
		setError('')
		if (!projectName) {
			setError('Name is required.')
			return
		}
		setCreating(true)
		try {
			const created = await props.client.create({
				name: projectName,
				id: projectId,
				template: 'react'
			})
			props.rememberOrg(projectId)
			await props.onCreated(created.slug)
		} catch (err) {
			setCreating(false)
			setError(messageOf(err))
		}
	}

	return (
		<ScreenWrap>
			<form onSubmit={submit}>
				<div style={styles.galleryHead}>
					<LinkButton label="‹ Cancel" onClick={props.onCancel} />
					<div style={{ fontWeight: '650', fontSize: '16px' }}>New Project</div>
					<PrimaryButton label="Create" type="submit" disabled={creating} />
				</div>
				<TextField
					label="Name"
					value={name}
					inputRef={nameRef}
					onChange={(value) => {
						setName(value)
						if (!idEdited) setId(`${props.org()}.${slugifyName(value)}`)
					}}
				/>
				<TextField
					label="Bundle Identifier"
					value={id}
					onChange={(value) => {
						setIdEdited(true)
						setId(value)
					}}
				>
					<div style={styles.hint}>Folder: /projects/{id} · must be unique</div>
				</TextField>
				<div style={styles.formError}>{error}</div>
			</form>
		</ScreenWrap>
	)
}

function ScreenWrap({ children }: { children: ReactNode }) {
	return (
		<div style={styles.screenOuter}>
			<div style={styles.screenInner}>{children}</div>
		</div>
	)
}

function TextField(props: {
	label: string
	value: string
	onChange: (value: string) => void
	children?: ReactNode
	inputRef?: { current: HTMLInputElement | null }
}) {
	return (
		<label style={{ margin: '0 0 16px', display: 'block' }}>
			<span style={styles.fieldLabel}>{props.label}</span>
			<input
				ref={props.inputRef}
				type="text"
				value={props.value}
				onChange={(event) => props.onChange(event.currentTarget.value)}
				style={styles.input}
			/>
			{props.children}
		</label>
	)
}

function TabButton(props: {
	path: string
	active: boolean
	dirty: boolean
	onSelect: (path: string) => void
}) {
	return (
		<button
			type="button"
			title={props.path}
			onClick={() => props.onSelect(props.path)}
			style={{
				...styles.tabButton,
				background: props.active ? '#ffffff' : 'transparent',
				color: props.active ? '#1d1d1f' : '#6e6e73',
				fontWeight: props.active ? '600' : '400'
			}}
		>
			{props.dirty ? '● ' : ''}
			{basename(props.path)}
		</button>
	)
}

function IconButton(props: { label: string; title: string; onClick: () => void }) {
	return (
		<button type="button" title={props.title} onClick={props.onClick} style={styles.iconButton}>
			{props.label}
		</button>
	)
}

function ShipButton(props: {
	label: string
	primary: boolean
	disabled: boolean
	onClick: () => void
}) {
	return (
		<button
			type="button"
			disabled={props.disabled}
			onClick={props.onClick}
			style={{
				...shipButtonStyle(props.primary),
				opacity: props.disabled ? 0.4 : 1
			}}
		>
			{props.label}
		</button>
	)
}

function PrimaryButton(props: {
	label: string
	onClick?: () => void
	type?: 'button' | 'submit'
	disabled?: boolean
}) {
	return (
		<button
			type={props.type ?? 'button'}
			disabled={props.disabled}
			onClick={props.onClick}
			style={styles.primaryButton}
		>
			{props.label}
		</button>
	)
}

function LinkButton(props: { label: string; onClick: () => void }) {
	return (
		<button type="button" onClick={props.onClick} style={styles.linkButton}>
			{props.label}
		</button>
	)
}

function fallbackText(state: CodeState, source: SourceView): { text: string; error: boolean } {
	if (state.files.length === 0) return { text: 'Empty project.', error: false }
	if (!state.selectedPath) return { text: 'Select a file to edit.', error: false }
	if (source.error) return { text: source.error, error: true }
	return { text: 'Loading…', error: false }
}

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

function codeToggleStyle(active: boolean): CSSProperties {
	return {
		border: `1px solid ${active ? '#007aff' : '#d2d2d7'}`,
		borderRadius: '6px',
		background: active ? '#007aff' : '#ffffff',
		color: active ? '#ffffff' : '#1d1d1f',
		cursor: 'default',
		font: 'inherit',
		fontSize: '12px',
		fontWeight: '600',
		padding: '5px 12px',
		whiteSpace: 'nowrap'
	}
}

function shipButtonStyle(primary: boolean): CSSProperties {
	return {
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
	}
}

const styles = {
	shell: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		width: '100%',
		background: '#ffffff',
		color: '#1d1d1f',
		fontFamily: 'var(--font-ui)',
		fontSize: 'var(--text-ui)'
	},
	toolbar: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		padding: '8px 12px',
		background: '#f5f5f7',
		borderBottom: '1px solid #d2d2d7'
	},
	toolbarSide: {
		display: 'flex',
		flex: '1 1 0',
		minWidth: '0',
		alignItems: 'center',
		gap: '8px'
	},
	nameLabel: {
		fontWeight: '600',
		fontSize: '13px',
		minWidth: '0',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		color: '#1d1d1f'
	},
	stateLabel: {
		flex: '0 0 auto',
		textAlign: 'center',
		fontSize: '12px',
		fontWeight: '600',
		whiteSpace: 'nowrap'
	},
	rightGroup: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'flex-end',
		flex: '1 1 0',
		minWidth: '0'
	},
	content: { display: 'flex', flex: '1 1 auto', minHeight: '0' },
	sourceView: {
		flexDirection: 'column',
		flex: '0 0 auto',
		minWidth: '0',
		minHeight: '0'
	},
	tabBar: {
		display: 'flex',
		flex: '0 0 auto',
		minWidth: '0',
		background: '#f5f5f7',
		borderBottom: '1px solid #e3e3e6'
	},
	tabsScroll: { display: 'flex', flex: '1 1 0', minWidth: '0', overflowX: 'auto' },
	editorHost: { flex: '1 1 auto', minHeight: '0', overflow: 'hidden' },
	message: {
		flex: '1 1 auto',
		margin: '0',
		minHeight: '0',
		overflow: 'auto',
		padding: '18px',
		background: '#ffffff',
		fontFamily: MONO,
		fontSize: '13px',
		lineHeight: '1.55',
		whiteSpace: 'pre-wrap'
	},
	handle: {
		flex: '0 0 auto',
		width: '5px',
		background: '#d2d2d7',
		cursor: 'col-resize'
	},
	appView: {
		display: 'flex',
		flexDirection: 'column',
		flex: '1 1 0',
		minWidth: '0',
		minHeight: '0',
		background: '#e8e8ed'
	},
	menubar: { flex: '0 0 auto', position: 'relative', zIndex: 2 },
	desktopArea: {
		display: 'flex',
		flex: '1 1 auto',
		minWidth: '0',
		minHeight: '0',
		position: 'relative',
		zIndex: 1,
		padding: '24px 24px 96px'
	},
	windowEl: {
		flex: '1 1 auto',
		minWidth: '0',
		minHeight: '0',
		position: 'relative',
		zIndex: 0
	},
	previewSlot: {
		position: 'relative',
		flex: '1 1 auto',
		minWidth: '0',
		minHeight: '0',
		overflow: 'hidden'
	},
	bottomBar: {
		flex: '0 0 auto',
		flexDirection: 'column',
		gap: '6px',
		maxHeight: '40%',
		overflow: 'auto',
		padding: '8px 12px',
		background: '#f5f5f7',
		borderTop: '1px solid #d2d2d7'
	},
	diagnostics: {
		margin: '0',
		color: '#c41a16',
		fontFamily: MONO,
		fontSize: '12px',
		lineHeight: '1.5',
		whiteSpace: 'pre-wrap'
	},
	dropdown: {
		position: 'absolute',
		left: '0',
		top: '100%',
		marginTop: '1px',
		zIndex: 10000
	},
	tabButton: {
		flex: '0 0 auto',
		border: '0',
		borderRight: '1px solid #e3e3e6',
		cursor: 'default',
		font: `12px ${MONO}`,
		padding: '6px 12px',
		whiteSpace: 'nowrap'
	},
	iconButton: {
		flex: '0 0 auto',
		border: '0',
		borderLeft: '1px solid #e3e3e6',
		background: 'transparent',
		color: '#6e6e73',
		cursor: 'default',
		font: 'inherit',
		fontSize: '13px',
		padding: '6px 10px'
	},
	primaryButton: {
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
	},
	linkButton: {
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
	},
	screenOuter: {
		flex: '1 1 auto',
		overflow: 'auto',
		background: '#ffffff',
		color: '#1d1d1f',
		fontFamily: 'var(--font-ui)',
		padding: '32px 20px'
	},
	screenInner: { maxWidth: '560px', margin: '0 auto', width: '100%' },
	galleryHead: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		marginBottom: '20px'
	},
	projectList: { border: '1px solid #e3e3e6', borderRadius: '10px', overflow: 'hidden' },
	projectRow: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '11px 14px',
		cursor: 'default'
	},
	fieldLabel: {
		display: 'block',
		fontSize: '12px',
		color: '#6e6e73',
		marginBottom: '6px'
	},
	input: {
		width: '100%',
		font: 'inherit',
		fontSize: '14px',
		padding: '8px 10px',
		border: '1px solid #d2d2d7',
		borderRadius: '7px',
		background: '#ffffff',
		color: '#1d1d1f',
		boxSizing: 'border-box'
	},
	hint: {
		fontFamily: MONO,
		fontSize: '12px',
		color: '#a1a1a6',
		marginTop: '6px'
	},
	formError: { fontSize: '13px', color: '#c41a16', minHeight: '18px', marginTop: '4px' }
} satisfies Record<string, CSSProperties>
