// Slice 11: the `devkit` capability in quayd — the one privileged surface app-code
// (Code) uses to compile, install, and pack the apps you build everything else with.
// quay supplies the two seams the shared `devkitCapability` factory needs: a
// `Toolchain` (quay's runtime-selected compile backend + the TypeScript compiler
// API for typecheck) and a `Runner` (live preview as a hidden `preview.<slug>` app
// installed into the SAME kernel the booters serve from). Everything between — read
// the project, build, pack, install — is the factory's generic pipeline.
//
// The compile backend is runtime-selected (`#engine`: native esbuild under node,
// `Bun.build` under bun). The gui resolves the SDK via the importmap (externalized); the
// reducer BUNDLES it, so the backend is fed the host's in-memory SDK source (`sdkSources`,
// the same `/vendor/<spec>.js` bytes) as its `runtime` map and inlines each referenced
// module into `app.js`. `install` fires `onInstalled` so quayd materialises its `.app`
// (Slice 6's reconcile) and the launcher re-lists — no change to app-code's reducer.

import { appBundleFromMemory } from '@justfiles/app'
import type { Compile, Toolchain } from '@justfiles/app/capabilities/devkit/host'
import {
	devkitCapability as makeDevkit,
	type Runner
} from '@justfiles/app/capabilities/devkit/host'
import { loadTypes } from '@justfiles/app/devkit-sysroot'
import type { Kernel } from '@justfiles/app/runtime'
import { typescriptToolchain } from '@justfiles/app/toolchain/typescript'
import type { Volume } from '@justfiles/fs'
import * as ts from 'typescript'
// The devkit compile backend, selected by the runtime: native esbuild under node,
// Bun.build under bun (package.json `imports` → `quayd/devkitEngine.{node,bun}.ts`).
// typecheck stays on tsc for both — only `compile` swaps.
import { compile as backendCompile } from '#engine'
import { sdkSources } from './assets.ts'

// `getKernel` is lazy because the kernel is built with this capability already in its
// registry (host.ts) — the kernel reference only exists after construction.
export function devkitCapability(
	fs: Volume,
	getKernel: () => Kernel,
	onInstalled: () => void | Promise<void>
) {
	// The in-process toolchain, keyed by the calling app's id: the `#engine` compile
	// backend (shared) for `compile`, the TypeScript compiler API for `typecheck`,
	// with the `.d.ts` overlay read from THAT app's installed types sysroot
	// (`devkit/**`, shipped by app-code). No node_modules/baked fallback — a host
	// always has app-code installed, so the headers are always present. Cached for
	// the daemon's life.
	const toolchains = new Map<string, Promise<Toolchain>>()
	const toolchain = (ctx: { appId: string }): Promise<Toolchain> => {
		let tc = toolchains.get(ctx.appId)
		if (!tc) {
			tc = (async () => {
				const installed = await getKernel().app(ctx.appId)
				return typescriptToolchain({
					compile: compileBackend(),
					ts,
					types: await loadTypes((path) => installed.read(path))
				})
			})()
			toolchains.set(ctx.appId, tc)
		}
		return tc
	}
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

// The compile backend (`#engine`) — esbuild under node, Bun.build under bun. The reducer
// bundles the SDK, so the backend is fed the host's in-memory SDK source as its `runtime`
// map (the gui still externalizes via the importmap and ignores it). `sdkSources` is the
// same `/vendor/<spec>.js` bytes, decoded and keyed by spec; memoised there. The bundler is
// the runtime's choice; this module never names it.
function compileBackend(): Compile {
	return async (input) => backendCompile(input, Object.fromEntries(await sdkSources()))
}
