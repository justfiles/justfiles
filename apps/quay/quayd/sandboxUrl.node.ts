// The Node side of the sandbox's runtime divergence (`#sandbox-url`): how a reducer
// bundle becomes a `node:worker_threads` Worker, including how its SDK imports resolve.
//
// Node's worker loader accepts `data:` URLs, and — unlike Bun — supports in-thread
// module customization hooks (`module.registerHooks`). So we keep the reducer's short
// `justfiles-sdk:<spec>` sentinels and install a hook (via `--import`, before the
// worker's main module loads) that serves each SDK module from the in-memory map handed
// in over `workerData`. The per-spawn worker URL therefore never embeds the SDK bytes —
// only the small reducer + its sentinels. (The bun sibling needs no hook: it rewrites each
// sentinel to a short `blob:` URL ahead of load, which is already small; see
// `sandboxUrl.bun.ts`.)

import type { WorkerOptions } from 'node:worker_threads'
import { sandboxWorkerSource } from '@justfiles/app/sandbox'
import { SDK_SENTINEL } from '@justfiles/app/sdk-externals'

const dataUrl = (source: string): string =>
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

// The `--import` preload: it runs before the worker's main (bootstrap) module, so the
// hook is active when the bootstrap's static `import { app }` resolves. It reads the SDK
// source map from `workerData` and serves each `justfiles-sdk:<spec>` straight from
// memory — never the filesystem, never a per-spawn `data:` blob of the SDK.
const sdkHook = dataUrl(`import { registerHooks } from 'node:module'
import { workerData } from 'node:worker_threads'
const sdk = workerData.sdk
const SENTINEL = ${JSON.stringify(SDK_SENTINEL)}
registerHooks({
	resolve: (spec, ctx, next) =>
		spec.startsWith(SENTINEL) ? { url: spec, shortCircuit: true } : next(spec, ctx),
	load(url, ctx, next) {
		if (!url.startsWith(SENTINEL)) return next(url, ctx)
		const source = sdk.get(url.slice(SENTINEL.length))
		if (source === undefined) throw new Error('sandbox: no SDK module for ' + url)
		return { format: 'module', source, shortCircuit: true }
	}
})`)

// Build the `new Worker(url, options)` arguments for `code`. `sdk` is the host's
// in-memory SDK map (omitted for a reducer that links no SDK — a pure-DOM app), passed
// to the worker's loader hook through `workerData` rather than baked into `url`.
export function sandboxWorker(
	code: string,
	sdk: Map<string, string> | undefined
): { url: URL; options?: WorkerOptions } {
	const url = new URL(dataUrl(sandboxWorkerSource(dataUrl(code), 'node')))
	if (!sdk) return { url }
	// Append the hook to the inherited execArgv (don't replace it).
	return {
		url,
		options: { execArgv: [...process.execArgv, '--import', sdkHook], workerData: { sdk } }
	}
}
