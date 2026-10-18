import type { Client } from '@justfiles/app'
import type { Diagnostic } from '@justfiles/app/capabilities/devkit'
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
	problems: Diagnostic[]
	client: Client<CodeApp>
	onSettings: () => void
	onCloseSettings: () => void
	onExport: () => Promise<void>
	onDelete: () => void
	localDirty: boolean
	split: number
	fileTreeOpen: boolean
	installing: boolean
	installLabel: string
	iconUrl: string | null
	previewSrc: string | null
	launched: boolean
	onStart: () => void
	onBack: () => void
	onToggleRun: () => void
	onRefresh: () => void
	onSelectPath: (path: string) => void
	onToggleFileTree: () => void
	onInstall: () => void
	onDrag: (event: ReactPointerEvent<HTMLDivElement>) => void
	onIconFile: (file: File) => void
	setSourceView: (el: HTMLDivElement | null) => void
	setContent: (el: HTMLDivElement | null) => void
}

export function EditorScreen(props: EditorScreenProps) {
	const iconInput = useRef<HTMLInputElement>(null)
	useEffect(() => props.onStart(), [props.onStart])
	const ready =
		!!props.view.selectedPath &&
		props.source.path === props.view.selectedPath &&
		props.source.content !== null
	const fallback = ready ? null : fallbackText(props.view, props.source)
	const build = props.view.build
	const diagnostics =
		props.problems.length > 0 ? props.problems.map(formatDiagnostic) : (build?.diagnostics ?? [])

	return (
		<>
			<div className="app-code-shell" hidden={props.settings}>
				<div className="app-code-toolbar">
					<div className="app-code-toolbar-side">
						<LinkButton label="‹ Projects" onClick={props.onBack} />
						<button
							type="button"
							onClick={props.onSettings}
							className="app-code-code-toggle"
							title="Project settings"
						>
							⚙
						</button>
						<button
							type="button"
							className="app-code-icon-tile"
							title="Set app icon"
							onClick={() => iconInput.current?.click()}
						>
							<img alt="" src={props.iconUrl ?? ICON_PLACEHOLDER} />
						</button>
						<div className="app-code-name-label">{props.name}</div>
					</div>
					<div className={`app-code-state-label ${props.badge.className}`}>
						● {props.badge.label}
					</div>
					<div className="app-code-right-group">
						<button
							type="button"
							onClick={props.onToggleRun}
							className="app-code-run-button"
							data-running={props.launched ? 'true' : undefined}
						>
							{props.launched ? '■ Stop' : '▶ Run'}
						</button>
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
						style={
							props.previewSrc
								? { flex: '0 0 auto', width: `${props.split * 100}%` }
								: { flex: '1 1 auto' }
						}
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

					{props.previewSrc ? (
						<>
							<div className="app-code-handle" onPointerDown={props.onDrag} />
							<div className="app-code-preview-pane">
								<iframe
									key={props.previewSrc}
									className="app-code-preview-frame"
									title="Live preview"
									src={props.previewSrc}
								/>
							</div>
						</>
					) : null}
				</div>

				<div className="app-code-bottom-bar" hidden={!build && diagnostics.length === 0}>
					<div
						className={`app-code-build-message ${build?.result === 'ok' ? 'is-ok' : 'is-error'}`}
						hidden={!build}
					>
						{build?.message ?? ''}
					</div>
					<pre className="app-code-diagnostics" hidden={diagnostics.length === 0}>
						{diagnostics.join('\n')}
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

function formatDiagnostic(diagnostic: Diagnostic): string {
	const code = diagnostic.code ? ` ${diagnostic.code}` : ''
	const label = `[${diagnostic.severity} ${diagnostic.source}${code}]`
	if (!diagnostic.file) return `${label} ${diagnostic.message}`
	return `${diagnostic.file}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${label} ${diagnostic.message}`
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
