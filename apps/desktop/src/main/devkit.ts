import {
	devkitCapability as makeDevkit,
	noopRunner,
	type Runner
} from '@justfiles/app/capabilities/devkit/host'
import { buildRuntime } from '@justfiles/app/devkit-runtime'
import type { Toolchain } from '@justfiles/app/engine'
import { esbuildCompile } from '@justfiles/app/engine/esbuild'
import type { Kernel } from '@justfiles/app/runtime'
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
async function toolchain(): Promise<Toolchain> {
	if (!runtimePromise) runtimePromise = buildRuntime()
	const runtime = await runtimePromise
	return { compile: (input) => esbuildCompile(input, build, runtime) }
}
