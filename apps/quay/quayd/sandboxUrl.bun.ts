// The Bun side of `#sandbox-url`. Bun's worker module loader throws ENAMETOOLONG on a
// large `data:` URL (it routes data: URLs through a path that blows PATH_MAX ≈ 1KB, and
// a real bundle is many KB — see the migration spike), so the worker module is a short
// `blob:` reference, which resolves at any size.
//
// The reducer's `justfiles-sdk:<spec>` sentinels are resolved AHEAD of load by rewriting
// each to a `blob:` URL of the SDK source (deduped across workers for the process life),
// NOT via a load-time loader hook like the node side. That's deliberate, not a
// limitation: a blob: URL is already a short reference (the SDK bytes live in the blob
// store, not in the import string), so the per-spawn worker URL stays small without a
// hook — node needs its hook only because data: URLs inline the SDK bytes. (Bun's own
// runtime-plugin hook could do this on recent bun, but it's marked experimental and buys
// no size win here — see the step-12 evaluation in docs/app-code-devkit-sysroot-plan.md.)
//
// We don't revoke the blob: URLs: workers are content-addressed (bounded by distinct
// bundles) and the daemon idle-exits, so the registry can't grow unbounded.

import type { WorkerOptions } from 'node:worker_threads'
import { sandboxWorkerSource } from '@justfiles/app/sandbox'
import { resolveSdkExternals } from '@justfiles/app/sdk-externals'

const blobUrl = (source: string): string =>
	URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))

// One blob: URL per SDK spec, built on first use and reused for the process life — so two
// apps importing the same SDK module share its URL.
const sdkUrls = new Map<string, string>()

// Build the `new Worker(url, options)` arguments for `code`. `sdk` is the host's in-memory
// SDK map (omitted for a reducer that links no SDK — a pure-DOM app); when present, each
// `justfiles-sdk:<spec>` sentinel is rewritten to a deduped blob: URL of the SDK source.
export function sandboxWorker(
	code: string,
	sdk: Map<string, string> | undefined
): { url: URL; options?: WorkerOptions } {
	const linked = sdk
		? resolveSdkExternals(code, (spec) => {
				let url = sdkUrls.get(spec)
				if (!url) {
					const source = sdk.get(spec)
					if (source === undefined) throw new Error(`sandbox: no SDK module for "${spec}"`)
					url = blobUrl(source)
					sdkUrls.set(spec, url)
				}
				return url
			})
		: code
	return { url: new URL(blobUrl(sandboxWorkerSource(blobUrl(linked), 'node'))) }
}
