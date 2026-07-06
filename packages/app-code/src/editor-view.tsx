import type { Client } from '@justfiles/app'
import type { DevkitPreview, Diagnostic } from '@justfiles/app/capabilities/devkit'
import type { ReactNode, PointerEvent as ReactPointerEvent } from 'react'
import { type CodeApp, type CodeState, statusOf } from './app'
import { createEditor } from './editor'
import { EditorScreen, type EditorScreenProps } from './editor-screen'
import { createWriter, downloadZip, messageOf, type SourceView, STATUS } from './gui-util'
import type { ProjectMeta } from './projects'

export type EditorController = {
	start(): void
	render(): void
	update(next: CodeState): void
	slug(): string | null
	leave(): Promise<void>
	destroy(): void
}

// The editor session: an imperative bridge between the kernel client and a single
// `EditorScreen` render. It owns the screen's mutable view state and re-renders
// via `patch()`. `nav.onLeave`/`onDelete` hand control back to the gui shell's
// gallery router.
export function createEditorView(
	client: Client<CodeApp>,
	render: (node: ReactNode) => void,
	nav: { onLeave: () => void; onDelete: () => void },
	initial: CodeState
): EditorController {
	let live = true
	let started = false
	let view = initial
	let source: SourceView = { path: null, content: null, error: null }
	let readToken = 0
	// The run loop: at most one compile in flight. A request mid-run sets `rerun`;
	// `blocked` halts new runs while the editor tears down.
	const run = { active: null as Promise<void> | null, running: false, rerun: false, blocked: false }
	let editorPath: string | null = null
	let localDirty = false
	let split = 0.5
	let fileTreeOpen = true
	let previewSrc: string | null = null
	let previewSeq = 0
	// Whether the live preview is currently running. The Run/Stop button toggles
	// it; only while running does saving a file hot-rebuild the preview.
	let launched = false
	// Type-check diagnostics, refreshed after each build and rendered inline in the
	// editor (filtered to the open file). Empty where the host has no checker
	// (typecheck → CAPABILITY_UNAVAILABLE).
	let problems: Diagnostic[] = []
	let installing = false
	let installLabel = 'Install'
	let iconUrl: string | null = null
	// The layout elements the controller measures/toggles imperatively.
	const els = {
		sourceView: null as HTMLElement | null,
		content: null as HTMLElement | null
	}
	// Settings is a mode of the open editor, not a sibling screen — the
	// preview slot stays mounted so the live App keeps running underneath.
	let settings = false
	let settingsMeta: ProjectMeta | null = null

	const displayName = () => view.name || view.slug || ''

	const writer = createWriter(async (path, content) => {
		localDirty = false
		try {
			await client.write({ path, content })
			if (launched) await runBuild()
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

	const refreshIcon = () => {
		void client
			.readIcon({})
			.then((url) => {
				if (!live) return
				iconUrl = typeof url === 'string' ? url : null
				patch()
			})
			.catch(() => {})
	}

	// Feed the editor the diagnostics for the file it currently shows. The engine
	// reports project-wide, keyed relative to the project ROOT (`src/app.ts`), while
	// the editor's `selectedPath` is relative to the `src/` dir (`app.ts`) — so match
	// the `src/`-prefixed form (and the bare form, in case a host keys it that way).
	const pushDiagnostics = () => {
		code.setDiagnostics(
			editorPath
				? problems.filter((p) => p.file === `src/${editorPath}` || p.file === editorPath)
				: []
		)
	}

	// Refresh diagnostics from the engine type-checker, then render them inline in
	// the editor. A failure (e.g. the host has no checker) just clears them — the
	// build/run path is unaffected.
	const refreshProblems = () => {
		void client
			.typecheck({})
			.then((result) => {
				if (!live) return
				problems = result.diagnostics
				pushDiagnostics()
			})
			.catch(() => {
				if (!live) return
				problems = []
				pushDiagnostics()
			})
	}

	const install = () => {
		if (installing) return
		installing = true
		installLabel = 'Installing…'
		patch()
		void (async () => {
			try {
				await writer.drain()
				await client.install({})
				installLabel = 'Installed ✓'
				setTimeout(() => {
					if (!live) return
					installLabel = 'Install'
					patch()
				}, 1500)
			} catch (err) {
				installLabel = 'Install'
				alert(messageOf(err))
			} finally {
				installing = false
				patch()
			}
		})()
	}

	// Export (Pack): drain pending writes, compile fresh, hand back the .zip.
	// The filename is the slug — display names collide and carry awkward
	// filename chars. The Settings screen owns the busy state, so this is just
	// the work; it throws on failure for the caller to surface.
	const exportZip = async () => {
		await writer.drain()
		const { zip } = await client.pack({})
		downloadZip(`${view.slug}.zip`, zip)
	}

	const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
		event.preventDefault()
		const rect = els.content?.getBoundingClientRect()
		if (!rect) return
		const onMove = (move: PointerEvent) => {
			split = Math.min(0.85, Math.max(0.15, (move.clientX - rect.left) / rect.width))
			if (els.sourceView) els.sourceView.style.width = `${split * 100}%`
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
		void client.select({ path }).catch(() => {})
	}

	const runBuild = (): Promise<void> => {
		if (run.blocked) return run.active ?? Promise.resolve()
		if (run.running) {
			run.rerun = true
			return run.active ?? Promise.resolve()
		}
		run.running = true
		patch()
		run.active = (async () => {
			try {
				const result = await client.run({})
				// A late run that resolves after Stop must not resurrect the preview.
				if (launched && result.preview?.kind === 'url') {
					const version = `${result.state.build?.hash ?? 'run'}-${++previewSeq}`
					previewSrc = versionedPreviewSrc(result.preview, version)
					patch()
				}
				// `kind: 'window'` needs nothing here — the host opened the preview in its
				// own window, so app-code stays a plain editor.
			} catch {
			} finally {
				run.running = false
				if (run.rerun && !run.blocked) {
					run.rerun = false
					await runBuild()
				} else {
					patch()
					refreshProblems()
				}
			}
		})()
		return run.active
	}

	// Run/Stop. Run launches the live preview (compile + mount: a separate OS
	// window on frieren, an embedded url pane on quay). Stop tears it down. Stop
	// waits out any in-flight run so the mount can't re-open behind the teardown.
	const runPreview = () => {
		if (launched) return
		launched = true
		patch()
		void runBuild()
	}
	const stopPreview = () => {
		if (!launched) return
		launched = false
		previewSrc = null
		run.rerun = false
		patch()
		void (async () => {
			if (run.active) await run.active.catch(() => {})
			await client.stop({}).catch(() => {})
		})()
	}

	const syncSource = () => {
		const path = view.selectedPath
		if (!path) {
			if (source.path !== null) readToken++
			source = { path: null, content: null, error: null }
			editorPath = null
			pushDiagnostics()
			return
		}
		if (source.path === path) return
		const token = ++readToken
		source = { path, content: null, error: null }
		void client
			.readFile({ path })
			.then((content) => {
				if (!live || token !== readToken) return
				source = { path, content, error: null }
				editorPath = path
				localDirty = false
				code.setDoc(content)
				pushDiagnostics()
				patch()
			})
			.catch((err) => {
				if (!live || token !== readToken) return
				source = { path, content: null, error: messageOf(err) }
				patch()
			})
	}

	// Load the manifest first, then flip to settings in one patch — no blank
	// flash, and the live preview keeps running behind the hidden shell.
	const openSettings = () => {
		if (settings) return
		void client
			.readMeta({})
			.then((meta) => {
				if (!live) return
				settingsMeta = meta
				settings = true
				patch()
			})
			.catch((err) => live && alert(messageOf(err)))
	}
	const closeSettings = () => {
		settings = false
		settingsMeta = null
		patch()
	}

	const props = (): EditorScreenProps => {
		const badge = STATUS[launched ? statusOf(view, run.running) : 'idle']
		return {
			view,
			source,
			code,
			badge,
			name: displayName(),
			settings,
			settingsMeta,
			client,
			onSettings: openSettings,
			onCloseSettings: closeSettings,
			onExport: exportZip,
			onDelete: nav.onDelete,
			localDirty,
			split,
			fileTreeOpen,
			installing,
			installLabel,
			iconUrl,
			previewSrc,
			launched,
			onStart: controller.start,
			onBack: nav.onLeave,
			onToggleRun: launched ? stopPreview : runPreview,
			onRefresh: () => {
				if (view.slug) void client.open({ slug: view.slug }).catch(() => {})
			},
			onSelectPath: selectPath,
			onToggleFileTree: () => {
				fileTreeOpen = !fileTreeOpen
				patch()
			},
			onInstall: install,
			onDrag: startDrag,
			onIconFile: (file) => {
				const reader = new FileReader()
				reader.onload = () => {
					const dataUrl = String(reader.result)
					iconUrl = dataUrl
					patch()
					void client.writeIcon({ dataUrl }).catch(() => {})
				}
				reader.readAsDataURL(file)
			},
			setSourceView: (el) => {
				els.sourceView = el
			},
			setContent: (el) => {
				els.content = el
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
		},
		render: patch,
		update(next) {
			view = next
			syncSource()
			patch()
		},
		slug: () => view.slug,
		async leave() {
			launched = false
			run.blocked = true
			if (run.active) await run.active.catch(() => {})
			await writer.drain()
			await client.stop({}).catch(() => {})
		},
		destroy() {
			live = false
			readToken++
			writer.flush()
			code.destroy()
		}
	}

	return controller
}

function versionedPreviewSrc(
	preview: Extract<DevkitPreview, { kind: 'url' }>,
	version?: string
): string {
	if (!version) return preview.src
	try {
		const url = new URL(preview.src, location.href)
		url.searchParams.set('v', version)
		return url.href
	} catch {
		return `${preview.src}${preview.src.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}`
	}
}
