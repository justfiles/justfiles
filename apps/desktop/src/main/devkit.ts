import type { Toolchain } from '@justfiles/app/capabilities/devkit/host'
import {
	devkitCapability as makeDevkit,
	noopRunner,
	type Runner
} from '@justfiles/app/capabilities/devkit/host'
import { buildRuntime } from '@justfiles/app/devkit-runtime'
import type { Kernel } from '@justfiles/app/runtime'
import { esbuildCompile } from '@justfiles/app/toolchain/esbuild'
import type { Volume } from '@justfiles/fs'
import { build } from 'esbuild'

let runtimePromise: Promise<Record<string, string>> | null = null

// Desktop wires the shared devkit factory with an esbuild-only `Toolchain` (no
// `typecheck` — the factory degrades it to CAPABILITY_UNAVAILABLE, as before) and
// the live-preview `Runner` (a WebContentsView; see `createPreviewManager`).
// Without a preview manager it falls back to `noopRunner` — `run` still compiles
// and reports diagnostics, it just mounts nothing.
export function devkitCapability(
	fs: Volume,
	getKernel: () => Kernel,
	onInstalled: () => void,
	preview?: Runner
) {
	return makeDevkit({
		fs,
		toolchain,
		runner: preview ?? noopRunner,
		kernel: getKernel,
		onInstalled
	})
}

// esbuild over the cached system runtime — compile only (no typecheck on desktop).
// Keyed by the calling app's id so a future per-app types sysroot (Step 6) caches
// per caller — today every caller gets the same compile-only toolchain.
const toolchains = new Map<string, Promise<Toolchain>>()
function toolchain(ctx: { appId: string }): Promise<Toolchain> {
	let tc = toolchains.get(ctx.appId)
	if (!tc) {
		tc = (async () => {
			if (!runtimePromise) runtimePromise = buildRuntime()
			const runtime = await runtimePromise
			return { compile: (input) => esbuildCompile(input, build, runtime) }
		})()
		toolchains.set(ctx.appId, tc)
	}
	return tc
}
