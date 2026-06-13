import { defineGUI } from '@justfiles/app/browser'
import { type ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { CodeApp } from './app'
import { createEditorView, type EditorController } from './editor-view'
import guiCss from './gui.css?inline'
import { messageOf, type Project, stateOrInitial } from './gui-util'
import { GalleryScreen, NewProjectScreen } from './screens'

export const gui = defineGUI<CodeApp>({
	mount(root, _state, ctx) {
		const styleEl = document.createElement('style')
		styleEl.textContent = guiCss
		document.head.append(styleEl)

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

		const openProject = async (slug: string) => {
			if (busy) return
			busy = true
			try {
				const next = await ctx.client.open({ slug })
				if (!mounted) return
				editor = createEditorView(
					ctx.client,
					render,
					{ onLeave: () => void leaveEditor(), onDelete: () => void deleteEditor() },
					stateOrInitial(next)
				)
				editor.render()
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

		// Delete the open project: capture its slug, then tear down like `leaveEditor`
		// (block runs → await the in-flight run + drain → stop → close) so no run
		// re-mounts and no watch lingers, then `remove` the folder. The slug is
		// captured before `close` nulls it (the procedure must take it as a param).
		const deleteEditor = async () => {
			if (busy || !editor) return
			busy = true
			const view = editor
			const slug = view.slug()
			editor = null
			try {
				await view.leave()
				await ctx.client.close({}).catch(() => {})
				if (slug) await ctx.client.remove({ slug })
				view.destroy()
			} catch (err) {
				alert(messageOf(err))
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
				styleEl.remove()
			}
		}
	}
})
