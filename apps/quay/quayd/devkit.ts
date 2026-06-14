// Slice 11: the `devkit` capability in quayd — the one privileged surface app-code
// (Code) uses to compile, install, and pack the apps you build everything else with.
// It's the same host-agnostic pipeline frieren and the desktop sibling drive
// (`@justfiles/app/devkit`), wired to quay's Node toolchain: native esbuild + the
// pre-bundled system `runtime` (`buildRuntime`, built once and cached). `installDraft`
// writes the finished bundle into the SAME `/applications` the launcher lists, then
// fires `onInstalled` so quayd materialises its `.app` (Slice 6's reconcile) and the
// launcher re-lists — no change to app-code's reducer.
//
// Live preview is deferred (DESIGN §9): the kernel lives in quayd while the Code
// window is a separate webview, so there is no in-process DOM to mount a draft into.
// `run` therefore compiles-only — it surfaces diagnostics for the build status but
// mounts nothing; `stop`/`menu`/`selectMenu` stay inert until the bespoke
// second-WKWebView preview lands.

import { appBundleFromMemory } from '@justfiles/app'
import { implementCapability } from '@justfiles/app/capabilities'
import { devkit } from '@justfiles/app/capabilities/devkit'
import { buildDraft, installDraft, packDraft, type Toolchain } from '@justfiles/app/devkit'
import { buildRuntime } from '@justfiles/app/devkit-runtime'
import type { Kernel } from '@justfiles/app/runtime'
import { chroot, type Volume } from '@justfiles/fs'
import { build } from 'esbuild'

let runtimePromise: Promise<Record<string, string>> | null = null

// `getKernel` is lazy because the kernel is built with this capability already in its
// registry (host.ts) — the kernel reference only exists after construction.
export function devkitCapability(
	fs: Volume,
	getKernel: () => Kernel,
	onInstalled: () => void | Promise<void>
) {
	return implementCapability(devkit, {
		// Quay treats install as ship-or-update: a re-install overwrites the live app
		// in place rather than rejecting the colliding id, so iterating in Code keeps
		// updating the same installed app.
		install: async (ctx, { slug }) =>
			installDraft(fs, ctx.appId, slug, getKernel(), await toolchain(), {
				onInstalled,
				overwrite: true
			}),
		pack: async (ctx, { slug }) =>
			packDraft(chroot(fs, `/data/${ctx.appId}`), slug, await toolchain()),
		// Live preview: compile the draft and install it as a hidden `preview.<slug>`
		// app in the SAME kernel the booters serve from. app-code then shows it in an
		// iframe over its preview slot, pointed at the app's normal shell — so the
		// berth + gui mount come free, and the running reducer makes it interactive.
		// `preview.*` is filtered from the launcher catalog + OS projection (main.ts);
		// `stop` uninstalls it. On a compile error the last-good preview stays put.
		run: async (ctx, { slug, reset }) => {
			const previewId = `preview.${slug}`
			const { manifest, app, gui, diagnostics } = await buildDraft(
				chroot(fs, `/data/${ctx.appId}`),
				slug,
				await toolchain()
			)
			if (diagnostics.length > 0 || !app || !gui) return { previewId, diagnostics }
			// ⟳ Run/Restart: wipe persisted draft state for a clean boot.
			if (reset) await fs.rm(`/state/${previewId}.json`, { force: true })
			await getKernel().install(
				appBundleFromMemory({ id: previewId, name: manifest.name, app, gui })
			)
			return { previewId, diagnostics }
		},
		stop: async (_ctx, { previewId }) => {
			await getKernel()
				.uninstall(previewId)
				.catch(() => {})
		},
		menu: async () => [],
		selectMenu: async () => {}
	})
}

// Native esbuild + the system runtime, built once and cached for the daemon's life.
async function toolchain(): Promise<Toolchain> {
	if (!runtimePromise) runtimePromise = buildRuntime()
	return { build, runtime: await runtimePromise }
}
