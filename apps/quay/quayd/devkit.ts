// Slice 11: the `devkit` capability in quayd — the one privileged surface app-code
// (Code) uses to compile, install, and pack the apps you build everything else with.
// quay supplies the backends the shared `devkitCapability` factory needs: a
// runtime-selected `compile` (`#engine`: native esbuild under node, `Bun.build`
// under bun), a tsc-backed `typecheck`, and a `Runner` (live preview as a hidden
// `preview.<slug>` app installed into the SAME kernel the booters serve from). The
// factory does everything between — load the calling app's installed devkit sysroot,
// read the project, build, pack, install. `install` fires `onInstalled` so quayd
// materialises its `.app` (Slice 6's reconcile) and the launcher re-lists — no change
// to app-code's reducer.

import { appBundleFromMemory } from '@justfiles/app'
import {
	devkitCapability as makeDevkit,
	type Runner
} from '@justfiles/app/capabilities/devkit/host'
import type { Kernel } from '@justfiles/app/runtime'
import { tsTypecheck } from '@justfiles/app/toolchain/typescript'
import type { Volume } from '@justfiles/fs'
import * as ts from 'typescript'
// The devkit compile backend, selected by the runtime: native esbuild under node,
// Bun.build under bun (package.json `imports` → `quayd/devkitEngine.{node,bun}.ts`).
// typecheck stays on tsc for both — only `compile` swaps.
import { compile as backendCompile } from '#engine'

// `getKernel` is lazy because the kernel is built with this capability already in its
// registry (host.ts) — the kernel reference only exists after construction.
export function devkitCapability(
	fs: Volume,
	getKernel: () => Kernel,
	onInstalled: () => void | Promise<void>
) {
	return makeDevkit({
		fs,
		kernel: getKernel,
		// `#engine` (native esbuild under node, Bun.build under bun) for `compile`; the
		// TypeScript compiler API for `typecheck`. The factory loads each calling app's
		// installed devkit sysroot (runtime + `.d.ts` overlay) and threads it in here —
		// no node_modules/baked fallback, since a host always has app-code installed.
		compile: backendCompile,
		typecheck: async (input, types, paths) => tsTypecheck(input, ts, types, paths),
		runner: quayRunner(fs, getKernel),
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
