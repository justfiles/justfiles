import type { Client } from '@justfiles/app'
import type { MenuView } from '@justfiles/app/capabilities/devkit'
import { FileTree as PierreFileTree, useFileTree } from '@pierre/trees/react'
import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from 'react'
import type { CodeApp, CodeState } from './app'
import { IconButton, LinkButton, ShipButton } from './controls'
import type { Editor } from './editor'
import { fallbackText, ICON_PLACEHOLDER, type SourceView } from './gui-util'
import type { ProjectMeta } from './projects'
import { SettingsScreen } from './screens'

export type EditorScreenProps = {
	view: CodeState
	source: SourceView
	code: Editor
	badge: { label: string; className: string }
	name: string
	settings: boolean
	settingsMeta: ProjectMeta | null
	client: Client<CodeApp>
	onSettings: () => void
	onCloseSettings: () => void
	onExport: () => Promise<void>
	onDelete: () => void
	localDirty: boolean
	split: number
	fileTreeOpen: boolean
	menuView: MenuView
	openMenu: number | null
	installing: boolean
	installLabel: string
	iconUrl: string | null
	onStart: () => void
	onBack: () => void
	onToggleCode: () => void
	onRefresh: () => void
	onSelectPath: (path: string) => void
	onToggleFileTree: () => void
	onInstall: () => void
	onDrag: (event: ReactPointerEvent<HTMLDivElement>) => void
	onIconFile: (file: File) => void
	onToggleMenu: (index: number) => void
	onEnterMenu: (index: number) => void
	onSelectMenu: (menu: number, item: number) => void
	setMenubar: (el: HTMLDivElement | null) => void
	setSourceView: (el: HTMLDivElement | null) => void
	setContent: (el: HTMLDivElement | null) => void
}

export function EditorScreen(props: EditorScreenProps) {
	const iconInput = useRef<HTMLInputElement>(null)
	useEffect(() => props.onStart(), [props.onStart])
	const showCode = props.view.view === 'source'
	const ready =
		!!props.view.selectedPath &&
		props.source.path === props.view.selectedPath &&
		props.source.content !== null
	const fallback = ready ? null : fallbackText(props.view, props.source)
	const build = props.view.build

	// quay live preview: the kernel runs in quayd, not this webview, so the draft
	// can't mount in-process the way it does in frieren. quayd installs it as a
	// hidden `preview.<slug>` app; we show it in an iframe over the slot, pointed at
	// the app's normal shell — quayd's boot script opens the berth and mounts the
	// gui, so it's fully interactive. A no-op in frieren (its devkit capability fills
	// the slot itself). `v=<hash>` reloads the frame on each fresh compile.
	const slug = props.view.slug
	const buildHash = build?.result === 'ok' ? build.hash : null
	useEffect(() => {
		const quay = (globalThis as { __quay?: { token?: string } }).__quay
		if (!quay || !slug || !buildHash) return
		const slot = document.querySelector('[data-preview-slot]')
		if (!slot) return
		let frame = slot.querySelector<HTMLIFrameElement>('iframe.app-code-preview-frame')
		if (!frame) {
			frame = document.createElement('iframe')
			frame.className = 'app-code-preview-frame'
			slot.replaceChildren(frame)
		}
		const token = encodeURIComponent(quay.token ?? '')
		const id = encodeURIComponent(`preview.${slug}`)
		frame.src = `/app/${id}?token=${token}&v=${encodeURIComponent(buildHash)}`
	}, [slug, buildHash])

	return (
		<>
			<div className="app-code-shell" hidden={props.settings}>
				<div className="app-code-toolbar">
					<div className="app-code-toolbar-side">
						<LinkButton label="‹ Projects" onClick={props.onBack} />
						<button
							type="button"
							onClick={props.onToggleCode}
							className="app-code-code-toggle"
							data-active={showCode ? 'true' : undefined}
						>
							{'</> Code'}
						</button>
						<button
							type="button"
							onClick={props.onSettings}
							className="app-code-code-toggle"
							title="Project settings"
						>
							⚙
						</button>
						<div className="app-code-name-label">{props.name}</div>
					</div>
					<div className={`app-code-state-label ${props.badge.className}`}>
						● {props.badge.label}
					</div>
					<div className="app-code-right-group">
						<ShipButton
							label={props.installLabel}
							disabled={props.installing}
							primary
							onClick={props.onInstall}
						/>
					</div>
				</div>

				<div ref={props.setContent} className="app-code-content">
					<div
						ref={props.setSourceView}
						className="app-code-source-view"
						hidden={!showCode}
						style={{ width: `${props.split * 100}%` }}
					>
						<div className="app-code-source-toolbar">
							<button
								type="button"
								className="app-code-tree-toggle"
								aria-pressed={props.fileTreeOpen}
								data-active={props.fileTreeOpen ? 'true' : undefined}
								title={props.fileTreeOpen ? 'Hide file tree' : 'Show file tree'}
								onClick={props.onToggleFileTree}
							>
								Files
							</button>
							<div className="app-code-source-path" title={props.view.selectedPath ?? undefined}>
								{props.localDirty ? '● ' : ''}
								{props.view.selectedPath ?? 'No file selected'}
							</div>
							<IconButton label="⟳" title="Rescan project files" onClick={props.onRefresh} />
						</div>
						<div className="app-code-source-body">
							<SourceFileTree
								files={props.view.files}
								selectedPath={props.view.selectedPath}
								hidden={!props.fileTreeOpen}
								onSelect={props.onSelectPath}
							/>
							<div className="app-code-editor-pane">
								<CodeMirrorHost editor={props.code} ready={ready} />
								<pre
									className={`app-code-message ${fallback?.error ? 'is-error' : ''}`}
									hidden={ready}
								>
									{fallback?.text ?? ''}
								</pre>
							</div>
						</div>
					</div>

					<div className="app-code-handle" hidden={!showCode} onPointerDown={props.onDrag} />

					<div className="app-code-app-view">
						<Menubar
							name={props.name}
							menuView={props.menuView}
							openMenu={props.openMenu}
							onToggle={props.onToggleMenu}
							onEnter={props.onEnterMenu}
							onSelect={props.onSelectMenu}
							setRef={props.setMenubar}
						/>
						<div className="app-code-desktop-area">
							<div
								className="ds-window ds-window-framed app-code-preview-window"
								data-focused="true"
							>
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
									<div data-preview-slot="" className="app-code-preview-slot" />
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

				<div className="app-code-bottom-bar" hidden={!build}>
					<div
						className={`app-code-build-message ${build?.result === 'ok' ? 'is-ok' : 'is-error'}`}
						hidden={!build}
					>
						{build?.message ?? ''}
					</div>
					<pre className="app-code-diagnostics" hidden={!build || build.diagnostics.length === 0}>
						{build?.diagnostics.join('\n') ?? ''}
					</pre>
				</div>

				<input
					ref={iconInput}
					type="file"
					accept="image/*"
					className="app-code-hidden-input"
					onChange={(event) => {
						const input = event.currentTarget
						const file = input.files?.[0]
						input.value = ''
						if (file) props.onIconFile(file)
					}}
				/>
			</div>
			{props.settings && props.settingsMeta ? (
				<SettingsScreen
					client={props.client}
					slug={props.view.slug ?? ''}
					meta={props.settingsMeta}
					onClose={props.onCloseSettings}
					onExport={props.onExport}
					onDelete={props.onDelete}
				/>
			) : null}
		</>
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
		<div ref={props.setRef} className="ds-menubar app-code-menubar">
			<span className="app-code-menubar-name">{props.name}</span>
			<div className="app-code-menu-list">
				{props.menuView.map((group, index) => (
					<div key={group.title} className="app-code-menu-wrap">
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
		<div className="ds-menu app-code-dropdown" role="menu">
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
						<span className="app-code-menu-check">{item.checked ? '✓' : ''}</span>
						<span className="app-code-menu-item-title">{item.title}</span>
						{item.shortcut ? <span className="app-code-menu-shortcut">{item.shortcut}</span> : null}
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
	return <div ref={ref} className="app-code-editor-host" hidden={!ready} />
}

function SourceFileTree(props: {
	files: string[]
	selectedPath: string | null
	hidden: boolean
	onSelect: (path: string) => void
}) {
	const latest = useRef(props)
	latest.current = props
	const { model } = useFileTree({
		paths: props.files,
		flattenEmptyDirectories: true,
		initialExpansion: 'open',
		initialSelectedPaths: props.selectedPath ? [props.selectedPath] : [],
		itemHeight: 24,
		density: 0.85,
		onSelectionChange: (paths) => {
			const { files, onSelect } = latest.current
			const path = paths.find((candidate) => files.includes(candidate))
			if (path) onSelect(path)
		}
	})

	useEffect(() => {
		model.resetPaths(props.files)
	}, [model, props.files])

	useEffect(() => {
		if (!props.selectedPath) return
		const item = model.getItem(props.selectedPath)
		if (!item) return
		const selected = model.getSelectedPaths()
		if (selected.length !== 1 || selected[0] !== props.selectedPath) {
			for (const path of selected) model.getItem(path)?.deselect()
			item.select()
		}
		model.scrollToPath(props.selectedPath, { focus: false })
	}, [model, props.selectedPath])

	return (
		<div className="app-code-file-tree-wrap" hidden={props.hidden}>
			<PierreFileTree model={model} className="app-code-file-tree" />
		</div>
	)
}
