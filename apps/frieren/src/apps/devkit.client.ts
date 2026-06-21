import { appBundleFromMemory } from '@justfiles/app'
import type { MenuView } from '@justfiles/app/capabilities/devkit'
import type { Runner, Toolchain } from '@justfiles/app/capabilities/devkit/host'
import { esbuildCompile } from '@justfiles/app/toolchain/esbuild'
import { chroot, type Volume } from '@justfiles/fs'
import * as host from './host'
import { createClientKernel } from './kernel.client'

// frieren's two devkit seams for the shared `devkitCapability` factory: the
// browser `Toolchain` (esbuild-wasm + the system runtime virtual module) and the
// `Runner` that owns the one thing that can't be shared — mounting the live
// preview into the caller's own `[data-preview-slot]`, same document, same thread.
// The caller only ever names the project (`slug`); the generic pipeline reads its
// `project.json` + source tree straight off the caller's data dir.

type GetToken = () => Promise<string | null>

// esbuild-wasm initialises once per page; the system runtime bundle loads with
// it. Both are pulled lazily so a session that never runs a draft pays nothing.
// No `typecheck` on the returned `Toolchain` — the factory degrades it to
// CAPABILITY_UNAVAILABLE (the 8 MB checker stays off the client; the container
// backend owns it online).
let toolchain: Promise<Toolchain> | undefined
export function getToolchain(): Promise<Toolchain> {
	toolchain ??= (async () => {
		const esbuild = await import('esbuild-wasm')
		const { default: wasmURL } = await import('esbuild-wasm/esbuild.wasm?url')
		await esbuild.initialize({ wasmURL })
		const { runtime } = await import('virtual:devkit-runtime')
		return { compile: (input) => esbuildCompile(input, esbuild.build, runtime) }
	})()
	return toolchain
}

// The frieren Runner. The factory hands `mount` a clean build (diagnostics already
// guarded) + the computed `preview.<slug>` id; we install it into a scoped client
// kernel and parent its live stage at the caller's content slot.
export function frierenRunner(fs: Volume, getToken: GetToken): Runner {
	return {
		mount: async (draft, { appId, slug, previewId, reset }) => {
			const scoped = chroot(fs, `/data/${appId}/.devkit/${slug}`)
			const kernel = createClientKernel({ fs: scoped, getToken })
			await kernel.install(
				appBundleFromMemory({
					id: previewId,
					name: draft.manifest.name,
					app: draft.app,
					gui: draft.gui
				})
			)
			host.close(previewId) // restart-safe: drop any prior isolate + stage
			// ⟳ Run/Restart: wipe persisted draft state so the next boot starts clean.
			// Done after close (old isolate gone, can't re-persist) and before open.
			if (reset) await scoped.rm(`/state/${previewId}.json`, { force: true })
			host.open(previewId, {
				getToken,
				localKernel: async () => kernel,
				volume: Promise.resolve(scoped)
			})
			// Parent the preview's stage at the caller's own content slot — same
			// document, same thread. The host created the wrapper synchronously in
			// open(); its async boot then mounts the gui into it. The app draws its own
			// window/menubar chrome around this slot (using the shared design CSS).
			const slot = host.wrapperOf(appId)?.querySelector('[data-preview-slot]')
			const child = host.wrapperOf(previewId)
			if (slot && child) slot.replaceChildren(child)
		},
		stop: async ({ previewId }) => {
			host.close(previewId)
		},
		// Mirror the preview stage's live menu into a display-only structure — the
		// `onSelect` closures stay here on the main thread, only titles/state cross
		// the boundary, so the app draws the real declared menus itself.
		menu: async ({ previewId }) => menuView(previewId),
		// Fire a preview menu item by position by invoking its real closure here on
		// the main thread — the action runs against the live preview's typed client.
		selectMenu: async ({ previewId, menu, item }) => {
			const entry = host.menuOf(previewId)?.[menu]?.items?.[item]
			if (entry && !('separator' in entry) && !entry.disabled) entry.onSelect()
		}
	}
}

function menuView(previewId: string): MenuView {
	const menus = host.menuOf(previewId)
	if (!menus) return []
	return menus.map((group) => ({
		title: group.title,
		items: group.items.map((item) =>
			'separator' in item
				? { separator: true }
				: {
						title: item.title,
						disabled: item.disabled,
						checked: item.checked,
						shortcut: item.shortcut
					}
		)
	}))
}
