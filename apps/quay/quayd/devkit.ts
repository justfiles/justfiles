// Slice 11: the `devkit` capability in quayd — the one privileged surface app-code
// (Code) uses to compile, install, and pack the apps you build everything else with.
// quay supplies the two seams the shared `devkitCapability` factory needs: a
// `Toolchain` (quay's runtime-selected compile backend + the TypeScript compiler
// API for typecheck) and a `Runner` (live preview as a hidden `preview.<slug>` app
// installed into the SAME kernel the booters serve from). Everything between — read
// the project, build, pack, install — is the factory's generic pipeline.
//
// The compile backend is runtime-selected (`#engine`: native esbuild under node,
// `Bun.build` under bun) over the pre-bundled system `runtime` (`buildRuntime`,
// built once and cached). `install` fires `onInstalled` so quayd materialises its
// `.app` (Slice 6's reconcile) and the launcher re-lists — no change to app-code's
// reducer.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appBundleFromMemory } from '@justfiles/app'
import type { Compile, Toolchain, TypesBundle } from '@justfiles/app/capabilities/devkit/host'
import {
	devkitCapability as makeDevkit,
	type Runner
} from '@justfiles/app/capabilities/devkit/host'
import { buildRuntime } from '@justfiles/app/devkit-runtime'
import type { Kernel } from '@justfiles/app/runtime'
import { typescriptToolchain } from '@justfiles/app/toolchain/typescript'
import type { Volume } from '@justfiles/fs'
import * as ts from 'typescript'
// The devkit compile backend, selected by the runtime: native esbuild under node,
// Bun.build under bun (package.json `imports` → `quayd/devkitEngine.{node,bun}.ts`).
// typecheck stays on tsc for both — only `compile` swaps.
import { compile as backendCompile } from '#engine'
import { ASSETS_DIR } from './resources.ts'

let runtimePromise: Promise<Record<string, string>> | null = null
let typesPromise: Promise<TypesBundle | undefined> | null = null

// `getKernel` is lazy because the kernel is built with this capability already in its
// registry (host.ts) — the kernel reference only exists after construction.
export function devkitCapability(
	fs: Volume,
	getKernel: () => Kernel,
	onInstalled: () => void | Promise<void>
) {
	return makeDevkit({
		fs,
		toolchain,
		runner: quayRunner(fs, getKernel),
		kernel: getKernel,
		onInstalled,
		// Quay treats install as ship-or-update: a re-install overwrites the live app
		// in place rather than rejecting the colliding id, so iterating in Code keeps
		// updating the same installed app.
		overwrite: true
	})
}

// Live preview: install the built draft as a hidden `preview.<slug>` app in the
// SAME kernel the booters serve from. app-code shows it in an iframe over its
// preview slot, pointed at the app's normal shell — so the berth + gui mount come
// free, and the running reducer makes it interactive. `preview.*` is filtered from
// the launcher catalog + OS projection (main.ts); `stop` uninstalls it. The factory
// only mounts a clean build, so there's no diagnostics guard here.
function quayRunner(fs: Volume, getKernel: () => Kernel): Runner {
	return {
		mount: async (draft, { previewId, reset }) => {
			// ⟳ Run/Restart: wipe persisted draft state for a clean boot.
			if (reset) await fs.rm(`/state/${previewId}.json`, { force: true })
			await getKernel().install(
				appBundleFromMemory({
					id: previewId,
					name: draft.manifest.name,
					app: draft.app,
					gui: draft.gui
				})
			)
		},
		stop: async ({ previewId }) => {
			await getKernel()
				.uninstall(previewId)
				.catch(() => {})
		}
	}
}

// The in-process toolchain: the `#engine` compile backend for `compile`, the
// TypeScript compiler API for `typecheck`. In dev the checker resolves the system
// libs from node_modules; shipped (no node_modules) it reads the baked TypesBundle
// (`loadTypes`). Shares the cached runtime.
async function toolchain(): Promise<Toolchain> {
	return typescriptToolchain({ compile: await compileBackend(), ts, types: await loadTypes() })
}

// The `.d.ts` overlay for typecheck. Shipped, the exe has no node_modules, so read the
// bundle baked at ship time (build-assets.ts → assets-dist/types.json) and the checker
// resolves the SDK/React types from it. In dev (no baked file) it stays undefined and
// typecheck falls through to node_modules. Cached for the daemon's life.
async function loadTypes(): Promise<TypesBundle | undefined> {
	if (!typesPromise)
		typesPromise = (async () => {
			const baked = join(ASSETS_DIR, 'types.json')
			return existsSync(baked)
				? JSON.parse(new TextDecoder().decode(await readFile(baked)))
				: undefined
		})()
	return typesPromise
}

// The compile backend (`#engine`) with the system runtime closed in — built once
// and cached for the daemon's life. The bundler is the runtime's choice; this
// module never names it.
async function compileBackend(): Promise<Compile> {
	if (!runtimePromise) runtimePromise = loadRuntime()
	const runtime = await runtimePromise
	return (input) => backendCompile(input, runtime)
}

// The devkit system runtime. Shipped, the self-contained exe has no node_modules for
// buildRuntime's esbuild pass, so read the copy baked at ship time (build-assets.ts →
// assets-dist/runtime.json). In dev (no baked file yet) build it from node_modules on
// first use. Cached for the daemon's life either way.
async function loadRuntime(): Promise<Record<string, string>> {
	const baked = join(ASSETS_DIR, 'runtime.json')
	if (existsSync(baked)) return JSON.parse(new TextDecoder().decode(await readFile(baked)))
	return buildRuntime()
}
