import { appBundleFromMemory } from '@justfiles/app'
import type {
	CheckResult,
	CompileResult,
	ImportCache,
	ProjectInput,
	ResolvedImports,
	Runner,
	TypePaths,
	TypesBundle
} from '@justfiles/app/capabilities/devkit/host'
import { type ToolchainClient, toolchainClient } from '@justfiles/app/toolchain/worker'
import { chroot, type Volume } from '@justfiles/fs'
import * as host from './host'
import { createClientKernel } from './kernel.client'

// Frieren runs compile and type-check jobs in one lazy worker. Preview mounting
// stays on the host because it needs the browser kernel and window shell.

type GetToken = () => Promise<string | null>

const IMPORT_CACHE = 'justfiles-devkit-imports-v1'
const FINAL_URL = 'x-justfiles-final-url'

const importCache: ImportCache = {
	async get(url) {
		const response = await (await caches.open(IMPORT_CACHE)).match(url)
		if (!response) return
		const finalUrl = response.headers.get(FINAL_URL)
		if (!finalUrl) throw new Error(`Invalid Devkit import cache entry: ${url}`)
		return { url: finalUrl, text: await response.text() }
	},
	async put(url, value) {
		const cache = await caches.open(IMPORT_CACHE)
		await cache.put(url, new Response(value.text, { headers: { [FINAL_URL]: value.url } }))
	}
}

export const frierenImports = { cache: importCache }

let toolchain: { worker: Worker; client: ToolchainClient } | undefined

function getToolchain(): ToolchainClient {
	if (toolchain) return toolchain.client
	const worker = new Worker(new URL('./devkit.toolchain.worker.ts', import.meta.url), {
		name: 'frieren-devkit-toolchain',
		type: 'module'
	})
	const client = toolchainClient({
		post: (message) => worker.postMessage(message),
		onMessage: (handle) => worker.addEventListener('message', (event) => handle(event.data))
	})
	const fail = (error: Error) => {
		if (toolchain?.worker !== worker) return
		toolchain = undefined
		client.fail(error)
		worker.terminate()
	}
	worker.addEventListener('error', (event) =>
		fail(event.error instanceof Error ? event.error : new Error(event.message))
	)
	worker.addEventListener('messageerror', () => fail(new Error('Devkit worker message failed')))
	toolchain = { worker, client }
	return client
}

export function frierenCompile(
	input: ProjectInput,
	runtime: Record<string, string>,
	imports?: ResolvedImports
): Promise<CompileResult> {
	return getToolchain().compile(input, runtime, imports)
}

export function frierenTypecheck(
	input: ProjectInput,
	types: TypesBundle,
	paths: TypePaths,
	imports?: ResolvedImports
): Promise<CheckResult> {
	return getToolchain().typecheck(input, types, paths, imports)
}

export function resetDevkitWorker(): void {
	const active = toolchain
	toolchain = undefined
	if (!active) return
	active.client.fail(new Error('Devkit worker stopped'))
	active.worker.terminate()
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
