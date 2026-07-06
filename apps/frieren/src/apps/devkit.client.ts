import { appBundleFromMemory } from '@justfiles/app'
import type { CompileResult, ProjectInput, Runner } from '@justfiles/app/capabilities/devkit/host'
import { esbuildCompile } from '@justfiles/app/toolchain/esbuild'
import { chroot, type Volume } from '@justfiles/fs'
import * as host from './host'
import { createClientKernel } from './kernel.client'

// frieren's two devkit seams for the shared `devkitCapability` factory: the browser
// `compile` backend (esbuild-wasm over the factory-loaded system runtime) and the
// `Runner` that owns the one thing that can't be shared — mounting the live preview
// into the caller's own `[data-preview-slot]`, same document, same thread. The
// caller only ever names the project (`slug`); the generic pipeline reads its
// `project.json` + source tree straight off the caller's data dir.

type GetToken = () => Promise<string | null>

// esbuild-wasm initialises ONCE per page (calling `initialize` twice throws),
// pulled lazily so a session that never runs a draft pays nothing — and the 8 MB
// checker never ships: frieren wires no `typecheck`, so the factory degrades it to
// CAPABILITY_UNAVAILABLE (the container backend owns typecheck online).
let esbuildReady: Promise<typeof import('esbuild-wasm')> | undefined
function getEsbuild(): Promise<typeof import('esbuild-wasm')> {
	if (!esbuildReady)
		esbuildReady = (async () => {
			const esbuild = await import('esbuild-wasm')
			const { default: wasmURL } = await import('esbuild-wasm/esbuild.wasm?url')
			await esbuild.initialize({ wasmURL })
			return esbuild
		})()
	return esbuildReady
}

// The browser `compile` backend: esbuild-wasm over the runtime the factory loaded
// from the caller's installed sysroot.
export async function frierenCompile(
	input: ProjectInput,
	runtime: Record<string, string>
): Promise<CompileResult> {
	const esbuild = await getEsbuild()
	return esbuildCompile(input, esbuild.build, runtime)
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
		}
	}
}
