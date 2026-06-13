import { defineGUI } from '@justfiles/app/browser'
import { type ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { CodeApp } from './app'
import { createEditorView, type EditorController } from './editor-view'
import guiCss from './gui.css?inline'
import { messageOf, type Project, stateOrInitial } from './gui-util'
import { GalleryScreen, NewProjectScreen } from './screens'

// The shell is a three-view local state machine over the kernel client. The
// gallery and the new-project form are pure screens derived from `view`; the
// editor is a stateful controller that owns its own ephemeral view state (see
// `createEditorView`) and drives its own renders. Durable, shared, agent-visible
// state — the open project (`slug`) and the source/app view — lives in the
// kernel reducer, not here; this union only tracks what the webview is showing.
type View =
	| { kind: 'gallery'; projects: Project[] }
	| { kind: 'newProject' }
	| { kind: 'editor'; controller: EditorController }

export const gui = defineGUI<CodeApp>({
	mount(root, _state, ctx) {
		const styleEl = document.createElement('style')
		styleEl.textContent = guiCss
		document.head.append(styleEl)

		const reactRoot = createRoot(root)
		let mounted = true
		// One transition at a time: open/leave/delete each touch the kernel and the
		// editor lifecycle, so they must not interleave.
		let busy = false
		let view: View = { kind: 'gallery', projects: [] }

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

		// Low-level: write a node to the root. The editor controller calls this
		// directly — it patches far more often than the shell changes view.
		const paintNode = (node: ReactNode) => {
			if (mounted) reactRoot.render(<StrictMode>{node}</StrictMode>)
		}

		// The single render: derive the surface from `view`. The editor branch hands
		// off to the controller, which paints its own `EditorScreen`.
		const paint = () => {
			if (view.kind === 'gallery')
				paintNode(
					<GalleryScreen
						projects={view.projects}
						onNew={toNewProject}
						onOpen={(slug) => void openProject(slug)}
					/>
				)
			else if (view.kind === 'newProject')
				paintNode(
					<NewProjectScreen
						client={ctx.client}
						org={org}
						rememberOrg={rememberOrg}
						onCancel={() => void toGallery()}
						onCreated={openProject}
					/>
				)
			else view.controller.render()
		}

		const toGallery = async () => {
			let projects: Project[] = []
			try {
				projects = await ctx.client.listProjects({})
			} catch {}
			if (!mounted) return
			view = { kind: 'gallery', projects }
			paint()
		}

		const toNewProject = () => {
			view = { kind: 'newProject' }
			paint()
		}

		const openProject = async (slug: string) => {
			if (busy) return
			busy = true
			try {
				const next = await ctx.client.open({ slug })
				if (!mounted) return
				const controller = createEditorView(
					ctx.client,
					paintNode,
					{ onLeave: () => void leaveEditor(), onDelete: () => void deleteEditor() },
					stateOrInitial(next)
				)
				view = { kind: 'editor', controller }
				paint()
			} catch (err) {
				if (!mounted) return
				alert(messageOf(err))
				await toGallery()
			} finally {
				busy = false
			}
		}

		// Leave the editor: tear it down (block runs → await the in-flight run +
		// drain → stop → close), then return to the gallery. `view` drops out of the
		// editor first (mirroring the old `editor = null`) so a late state push is
		// ignored instead of hitting the dying controller.
		const leaveEditor = async () => {
			if (busy || view.kind !== 'editor') return
			busy = true
			const controller = view.controller
			view = { kind: 'gallery', projects: [] }
			try {
				await controller.leave()
				await ctx.client.close({}).catch(() => {})
				controller.destroy()
			} finally {
				busy = false
			}
			await toGallery()
		}

		// Delete the open project: capture its slug, then tear down like
		// `leaveEditor` so no run re-mounts and no watch lingers, then `remove` the
		// folder. The slug is captured before `close` clears it (the procedure must
		// take it as a param).
		const deleteEditor = async () => {
			if (busy || view.kind !== 'editor') return
			busy = true
			const controller = view.controller
			const slug = controller.slug()
			view = { kind: 'gallery', projects: [] }
			try {
				await controller.leave()
				await ctx.client.close({}).catch(() => {})
				if (slug) await ctx.client.remove({ slug })
				controller.destroy()
			} catch (err) {
				alert(messageOf(err))
			} finally {
				busy = false
			}
			await toGallery()
		}

		void (async () => {
			await ctx.client.close({}).catch(() => {})
			if (mounted) await toGallery()
		})()

		return {
			update(next) {
				if (view.kind === 'editor') view.controller.update(stateOrInitial(next))
			},
			unmount() {
				mounted = false
				if (view.kind === 'editor') view.controller.destroy()
				reactRoot.unmount()
				styleEl.remove()
			}
		}
	}
})
