import type { GetSandbox, Sandbox } from '@justfiles/app'

// Phase 1: a `GetSandbox` backed by Cloudflare Worker Loader. The kernel's
// `run` becomes a single RPC into an isolated dynamic worker that loads the
// app's compiled `app.js`. Validation already lives in the bundle
// (defineApp), so this is *only* the adapter — no schemas, no validation.

// Worker Loader needs a WorkerEntrypoint as the main module. This wrapper
// imports the app bundle and exposes `dispatch` as the one RPC the kernel
// calls. `ctx` (state + `setState`) crosses by RPC; host services are
// exposed only through explicit capability invocation.
const ENTRY = `import { WorkerEntrypoint } from 'cloudflare:workers'
import { app } from './app.js'
export default class extends WorkerEntrypoint {
	dispatch(action, ctx) { return app.dispatch(action, ctx) }
	actions() { return app.actions ?? {} }
	capabilities() { return app.capabilities ?? {} }
	runProcedure(name, params, handle) { return app.runProcedure(name, params, handle) }
}`

// Content-addressed so identical app code reuses the loaded isolate
// (kernel.dispatch calls sandbox() on every action); `getCode` only runs
// on a cache miss.
async function cacheKey(code: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
	return `kernel-${hex.slice(0, 16)}`
}

type Dispatcher = {
	dispatch: Sandbox['run']
	actions?: Sandbox['actions']
	capabilities?: Sandbox['capabilities']
	runProcedure: NonNullable<Sandbox['runProcedure']>
}

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

export function workerSandbox(loader: Loader): GetSandbox {
	return async ({ code }) => {
		const stub = loader.get(await cacheKey(code), async () => ({
			compatibilityDate: '2026-04-10',
			mainModule: 'entry.js',
			modules: { 'entry.js': ENTRY, 'app.js': code },
			// App sandbox: no outbound network — capabilities arrive via ctx.
			globalOutbound: null
		}))
		const entry = stub.getEntrypoint() as unknown as Dispatcher
		// The kernel owns the capability callback now: it rides in `ctx`
		// (alongside `setState`) and the kernel attaches trusted scopes + appId.
		return {
			run: (action, ctx) => entry.dispatch(action, ctx),
			actions: () => entry.actions?.() ?? Promise.resolve({}),
			capabilities: () => entry.capabilities?.() ?? Promise.resolve({}),
			// The handle's dispatch/settled/read cross back into the kernel as RPC
			// stubs (same mechanism as ctx.setState/capabilityInvoke).
			runProcedure: (name, params, handle) => entry.runProcedure(name, params, handle)
		}
	}
}
