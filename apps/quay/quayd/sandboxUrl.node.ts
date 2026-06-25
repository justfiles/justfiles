// The Node side of `#sandbox-url`: how a reducer bundle becomes a `node:worker_threads`
// Worker. Node's worker loader accepts `data:` URLs, so the worker module is a `data:` URL
// of the bootstrap (the bun sibling uses `blob:` because Bun's loader throws ENAMETOOLONG
// on large data: URLs).
//
// The app bundle is self-contained — the reducer compile bundles every module it
// references into `app.js` — so there is no SDK loader hook: the worker just loads the
// bundle from a data: URL.

import type { WorkerOptions } from 'node:worker_threads'
import { sandboxWorkerSource } from '@justfiles/app/sandbox'

const dataUrl = (source: string): string =>
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

// Build the `new Worker(url, options)` arguments for the self-contained app bundle `code`.
export function sandboxWorker(code: string): { url: URL; options?: WorkerOptions } {
	return { url: new URL(dataUrl(sandboxWorkerSource(dataUrl(code), 'node'))) }
}
