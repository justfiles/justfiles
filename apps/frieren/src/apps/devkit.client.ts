import { appBundleFromMemory } from '@justfiles/app'
import type { CompileResult, ProjectInput, Runner } from '@justfiles/app/capabilities/devkit/host'
import { esbuildCompile } from '@justfiles/app/toolchain/esbuild'
import { chroot, type Volume } from '@justfiles/fs'
import * as host from './host'
import { createClientKernel } from './kernel.client'

// frieren's two devkit seams for the shared `devkitCapability` factory: the browser
// `compile` backend (esbuild-wasm over the factory-loaded system runtime) and the
// `Runner` that owns the one thing that can't be shared — launching the live
// preview. frieren mounts the draft in a scoped kernel and frames it as its own
// sandboxed OS window (`kind: 'window'`). The caller only ever names the project
// (`slug`); the generic pipeline reads its `project.json` + source tree straight
// off the caller's data dir.

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
// kernel, open its stage, and ask the OS shell to frame it as its own window. The
// preview is a normal sandboxed app window beside app-code — no host-DOM reach, so
// app-code stays fully sandboxed like every other app.
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
				localKernel: async () => kernel,
				volume: Promise.resolve(scoped)
			})
			// Frame the preview stage as its own window. Idempotent across ⟳ Run
			// (the window persists; only the stage is recreated, and the window's
			// viewport re-attaches the fresh wrapper via subscribeStage).
			host.requestWindow({ type: 'open', id: previewId, title: draft.manifest.name })
			return { kind: 'window' }
		},
		stop: async ({ previewId }) => {
			host.requestWindow({ type: 'close', id: previewId })
		}
	}
}
