import type { Toolchain } from '@justfiles/app/capabilities/devkit/host'
import {
	devkitCapability as makeDevkit,
	noopRunner,
	type Runner
} from '@justfiles/app/capabilities/devkit/host'
import { loadRuntime } from '@justfiles/app/devkit-sysroot'
import type { Kernel } from '@justfiles/app/runtime'
import { esbuildCompile } from '@justfiles/app/toolchain/esbuild'
import type { Volume } from '@justfiles/fs'
import { build } from 'esbuild'

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
		toolchain: toolchain(getKernel),
		runner: preview ?? noopRunner,
		kernel: getKernel,
		onInstalled
	})
}

// esbuild over the caller's installed devkit runtime sysroot — compile only (no
// typecheck on desktop). Keyed by app id so each caller's sysroot is loaded once.
function toolchain(getKernel: () => Kernel): (ctx: { appId: string }) => Promise<Toolchain> {
	const toolchains = new Map<string, Promise<Toolchain>>()
	return (ctx) => {
		let tc = toolchains.get(ctx.appId)
		if (!tc) {
			tc = (async () => {
				const installed = await getKernel().app(ctx.appId)
				const runtime = await loadRuntime((path) => installed.read(path))
				return { compile: (input) => esbuildCompile(input, build, runtime) }
			})()
			toolchains.set(ctx.appId, tc)
		}
		return tc
	}
}
