// The Bun side of `#sandbox-url`. Bun's worker module loader throws ENAMETOOLONG on a
// large `data:` URL (it routes data: URLs through a path that blows PATH_MAX ≈ 1KB, and
// a real bundle is many KB — see the migration spike), so the worker module is a short
// `blob:` reference, which resolves at any size. The node sibling uses a `data:` URL.
//
// The app bundle is self-contained — the reducer compile bundles every module it
// references into `app.js` — so there is no SDK link step here: the worker just loads the
// bundle from a blob: URL. We don't revoke the blob: URLs: workers are content-addressed
// (bounded by distinct bundles) and the daemon idle-exits, so the registry can't grow
// unbounded.

import type { WorkerOptions } from 'node:worker_threads'
import { sandboxWorkerSource } from '@justfiles/app/sandbox'

const blobUrl = (source: string): string =>
	URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))

// Build the `new Worker(url, options)` arguments for the self-contained app bundle `code`.
export function sandboxWorker(code: string): { url: URL; options?: WorkerOptions } {
	return { url: new URL(blobUrl(sandboxWorkerSource(blobUrl(code), 'node'))) }
}
