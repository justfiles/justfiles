import { appBundleFromMemory } from '@justfiles/app'
import { chroot, type Volume } from '@justfiles/fs'
import { capabilityError } from '../../shared/capability-error'
import { compile } from '../../shared/devkit.compile'
import * as host from './host'
import { createClientKernel } from './kernel.client'

// Local, main-thread `devkit` capability impl. It holds the toolchain
// (esbuild-wasm + the system runtime) and the host natively, so it can compile
// a draft, run it in a kernel scoped to the caller's private scratch folder,
// and parent the live app at the caller's own `[data-preview-slot]`. Nothing
// here crosses the worker boundary — the reducer only ever exchanges file
// strings, ids and diagnostics. Routed only for allowlisted apps (see
// capabilities.client / devkit.allowlist).

type GetToken = () => Promise<string | null>
type RunInput = { slug: string; files: Record<string, string> }
type Toolchain = { build: Parameters<typeof compile>[1]; runtime: Record<string, string> }

// esbuild-wasm initialises once per page; the system runtime bundle loads with
// it. Both are pulled lazily so a session that never runs a draft pays nothing.
let toolchain: Promise<Toolchain> | undefined
function getToolchain(): Promise<Toolchain> {
	toolchain ??= (async () => {
		const esbuild = await import('esbuild-wasm')
		const { default: wasmURL } = await import('esbuild-wasm/esbuild.wasm?url')
		await esbuild.initialize({ wasmURL })
		const { runtime } = await import('virtual:devkit-runtime')
		return { build: esbuild.build, runtime }
	})()
	return toolchain
}

export async function invokeDevkit(
	fs: Volume,
	getToken: GetToken,
	req: { method: string; input: unknown; appId: string }
): Promise<unknown> {
	switch (req.method) {
		case 'run':
			return run(fs, getToken, req.appId, runInput(req.input))
		case 'stop':
			return stop(stopInput(req.input))
		default:
			// install/pack land in slice 5.
			throw capabilityError('CAPABILITY_UNAVAILABLE', 'devkit', req.method)
	}
}

async function run(
	fs: Volume,
	getToken: GetToken,
	appId: string,
	{ slug, files }: RunInput
): Promise<{ previewId: string; diagnostics: string[] }> {
	const previewId = `preview.${slug}`
	const { build, runtime } = await getToolchain()
	const { app, gui, diagnostics } = await compile(files, build, runtime)
	// Compile failed — leave the last-good preview mounted and surface the errors.
	if (diagnostics.length > 0 || !app || !gui) return { previewId, diagnostics }

	const scoped = chroot(fs, `/data/${appId}/.devkit/${slug}`)
	const kernel = createClientKernel({ fs: scoped, getToken })
	await kernel.install(appBundleFromMemory({ id: previewId, name: slug, app, gui }))
	host.close(previewId) // restart-safe: drop any prior isolate + stage
	host.open(previewId, {
		getToken,
		localKernel: async () => kernel,
		volume: Promise.resolve(scoped)
	})
	// Parent the preview's stage at the caller's own slot — same document, same
	// thread. The host created the wrapper synchronously in open(); its async
	// boot then mounts the gui into it.
	const slot = host.wrapperOf(appId)?.querySelector('[data-preview-slot]')
	const child = host.wrapperOf(previewId)
	if (slot && child) slot.replaceChildren(child)
	return { previewId, diagnostics }
}

async function stop({ previewId }: { previewId: string }): Promise<void> {
	host.close(previewId)
}

function runInput(input: unknown): RunInput {
	const value = input as { slug?: unknown; files?: unknown }
	if (typeof value?.slug !== 'string' || !isStringRecord(value.files)) {
		throw capabilityError('CAPABILITY_INVALID_INPUT', 'devkit', 'run')
	}
	return { slug: value.slug, files: value.files }
}

function stopInput(input: unknown): { previewId: string } {
	const value = input as { previewId?: unknown }
	if (typeof value?.previewId !== 'string') {
		throw capabilityError('CAPABILITY_INVALID_INPUT', 'devkit', 'stop')
	}
	return { previewId: value.previewId }
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		!!value &&
		typeof value === 'object' &&
		Object.values(value).every((entry) => typeof entry === 'string')
	)
}
