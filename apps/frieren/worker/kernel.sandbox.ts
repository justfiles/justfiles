import type { GetSandbox, Sandbox } from '@justfiles/app'

// Phase 1: a `GetSandbox` backed by Cloudflare Worker Loader. The kernel's
// `run` becomes a single RPC into an isolated dynamic worker that loads the
// app's compiled `app.js`. Validation already lives in the bundle
// (defineApp), so this is *only* the adapter — no schemas, no validation.

// Worker Loader needs a WorkerEntrypoint as the main module. This wrapper
// imports the app bundle and exposes `dispatch` as the one RPC the kernel
// calls. `ctx` (state + the host `files` Volume + `setState`) crosses by
// RPC: the plain Volume's methods and `setState` become stubs, so app file
// I/O round-trips back to the host volume.
const ENTRY = `import { WorkerEntrypoint } from 'cloudflare:workers'
import { app } from './app.js'
export default class extends WorkerEntrypoint {
	dispatch(action, ctx) { return app.dispatch(action, ctx) }
	actions() { return app.actions ?? {} }
}`

// Content-addressed so identical app code reuses the loaded isolate
// (kernel.dispatch calls sandbox() on every action); `getCode` only runs
// on a cache miss.
async function cacheKey(code: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
	return `kernel-${hex.slice(0, 16)}`
}

type Dispatcher = { dispatch: Sandbox['run']; actions?: Sandbox['actions'] }

// Structural — only what we use. Kept free of the generated `WorkerLoader`
// global so the adapter type-checks both in the worker project and when
// imported by tests (a different tsconfig). The real `env.LOADER` binding
// satisfies this shape.
type WorkerCode = {
	compatibilityDate: string
	mainModule: string
	modules: Record<string, string>
	globalOutbound: null
}
type Loader = {
	get(name: string | null, getCode: () => Promise<WorkerCode>): { getEntrypoint(): unknown }
}

type CapabilityInvocation = {
	capability: string
	method: string
	input: unknown
	actor?: string
}

type WorkerSandboxOptions = {
	capabilities?: (req: CapabilityInvocation & { appId: string }) => Promise<unknown>
}

export function workerSandbox(loader: Loader, options: WorkerSandboxOptions = {}): GetSandbox {
	return async ({ appId, code }) => {
		const stub = loader.get(await cacheKey(code), async () => ({
			compatibilityDate: '2026-04-10',
			mainModule: 'entry.js',
			modules: { 'entry.js': ENTRY, 'app.js': code },
			// App sandbox: no outbound network — capabilities arrive via ctx.
			globalOutbound: null
		}))
		const entry = stub.getEntrypoint() as unknown as Dispatcher
		const capabilities = options.capabilities
		const capabilityInvoke = capabilities
			? (req: CapabilityInvocation) => capabilities({ ...req, appId })
			: undefined
		return {
			run: (action, ctx) => entry.dispatch(action, { ...ctx, capabilityInvoke }),
			actions: () => entry.actions?.() ?? Promise.resolve({})
		}
	}
}
