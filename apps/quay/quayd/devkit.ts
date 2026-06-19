// Slice 11: the `devkit` capability in quayd — the one privileged surface app-code
// (Code) uses to compile, install, and pack the apps you build everything else with.
// It's the same host-agnostic pipeline frieren and the desktop sibling drive
// (`@justfiles/app/devkit`), wired to quay's runtime-selected compile backend
// (`#engine`: native esbuild under node, `Bun.build` under bun) + the pre-bundled
// system `runtime` (`buildRuntime`, built once and cached). `installDraft`
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
import {
	buildDraft,
	compileDraft,
	installDraft,
	packDraft,
	type Toolchain,
	typecheckDraft
} from '@justfiles/app/devkit'
import { buildRuntime } from '@justfiles/app/devkit-runtime'
import type { Compile, Engine } from '@justfiles/app/engine'
import { typescriptEngine } from '@justfiles/app/engine/typescript'
import type { Kernel } from '@justfiles/app/runtime'
import { chroot, type Volume } from '@justfiles/fs'
import * as ts from 'typescript'
// The devkit compile backend, selected by the runtime: native esbuild under node,
// Bun.build under bun (package.json `imports` → `quayd/devkitEngine.{node,bun}.ts`).
// typecheck stays on tsc for both — only `compile` swaps.
import { compile as backendCompile } from '#engine'

let runtimePromise: Promise<Record<string, string>> | null = null

// `getKernel` is lazy because the kernel is built with this capability already in its
// registry (host.ts) — the kernel reference only exists after construction.
export function devkitCapability(
	fs: Volume,
	getKernel: () => Kernel,
	onInstalled: () => void | Promise<void>
) {
	return implementCapability(devkit, {
		// Engine methods (in-process: the `#engine` compile backend + the TypeScript
		// compiler API). quay has node_modules, so the checker resolves the system libs
		// from the same source the runtime is bundled from — no baked TypesBundle needed.
		compile: async (ctx, { slug }) =>
			compileDraft(chroot(fs, `/data/${ctx.appId}`), slug, await engine()),
		typecheck: async (ctx, { slug }) =>
			typecheckDraft(chroot(fs, `/data/${ctx.appId}`), slug, await engine()),
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

// The compile backend (`#engine`) with the system runtime closed in — built once
// and cached for the daemon's life. The bundler is the runtime's choice; this
// module never names it.
async function compileBackend(): Promise<Compile> {
	if (!runtimePromise) runtimePromise = buildRuntime()
	const runtime = await runtimePromise
	return (input) => backendCompile(input, runtime)
}

// The build/pack toolchain: just the compile backend (run/install/pack don't
// typecheck).
async function toolchain(): Promise<Toolchain> {
	return { compile: await compileBackend() }
}

// The in-process engine: the `#engine` compile backend for `compile`, the
// TypeScript compiler API for `typecheck`. Shares the cached runtime.
async function engine(): Promise<Engine> {
	return typescriptEngine({ compile: await compileBackend(), ts })
}
