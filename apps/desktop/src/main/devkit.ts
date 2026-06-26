import {
	devkitCapability as makeDevkit,
	noopRunner,
	type Runner
} from '@justfiles/app/capabilities/devkit/host'
import type { Kernel } from '@justfiles/app/runtime'
import { esbuildCompile } from '@justfiles/app/toolchain/esbuild'
import type { Volume } from '@justfiles/fs'
import { build } from 'esbuild'

// Desktop wires the shared devkit factory with a native-esbuild `compile` and no
// `typecheck` (the factory degrades it to CAPABILITY_UNAVAILABLE and never loads
// the `.d.ts` overlay), plus the live-preview `Runner` (a WebContentsView; see
// `createPreviewManager`). Without a preview manager it falls back to `noopRunner`
// — `run` still compiles and reports diagnostics, it just mounts nothing. The
// factory loads each caller's installed devkit runtime sysroot itself.
export function devkitCapability(
	fs: Volume,
	kernel: Kernel,
	onInstalled: () => void,
	preview?: Runner
) {
	return makeDevkit({
		fs,
		kernel,
		compile: (input, runtime) => esbuildCompile(input, build, runtime),
		runner: preview ?? noopRunner,
		onInstalled
	})
}
