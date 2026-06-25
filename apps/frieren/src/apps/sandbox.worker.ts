import type { GetSandbox, Sandbox } from '@justfiles/app'
import { sandboxClient, sandboxWorkerSource } from '@justfiles/app/sandbox'

// Browser-side `GetSandbox`. It runs the same volume-backed app.js bytes as the
// server kernel, but in a module Web Worker. The host↔isolate protocol lives in
// `@justfiles/app/sandbox` (shared with the desktop Node sandbox); this is only
// the Web-Worker transport plus the content-addressed worker cache.

type WorkerClient = { sandbox: Sandbox; terminate: () => void }

// One Web Worker per distinct app bundle (content hash), shared across every
// window of that app — mirroring the server's content-addressed isolate-per-app
// model. `appWorkers` maps an app id to its current bundle key so the host can
// `terminateAppWorker` when an app's last window closes (apps are 1:1 with their
// code, so an id resolves to exactly one worker).
const workers = new Map<string, Promise<WorkerClient>>()
const appWorkers = new Map<string, string>()

export function browserSandbox(): GetSandbox {
	return async ({ appId, code }) => {
		const key = await cacheKey(code)
		const worker = await workerFor(key, code)
		appWorkers.set(appId, key)
		return worker.sandbox
	}
}

function workerFor(key: string, code: string): Promise<WorkerClient> {
	let worker = workers.get(key)
	if (!worker) {
		worker = Promise.resolve(createWorker(code, () => workers.delete(key)))
		workers.set(key, worker)
	}
	return worker
}

// Terminate the worker backing `appId` (called by the host when the app's last
// window closes) so its thread and bundle blob are reclaimed.
export function terminateAppWorker(appId: string): void {
	const key = appWorkers.get(appId)
	if (!key) return
	appWorkers.delete(appId)
	const worker = workers.get(key)
	workers.delete(key)
	void worker?.then((client) => client.terminate()).catch(() => {})
}

async function cacheKey(code: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// `onDead` evicts this client from the worker cache so a crashed worker is never
// handed back out; the next dispatch rebuilds a fresh one.
function createWorker(code: string, onDead: () => void): WorkerClient {
	// The app bundle is self-contained — the reducer compile bundles its SDK into `app.js` —
	// so the worker loads it directly from a blob: URL; no spawn-time link step.
	const appUrl = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))
	const workerUrl = URL.createObjectURL(
		new Blob([sandboxWorkerSource(appUrl, 'web')], { type: 'application/javascript' })
	)
	const worker = new Worker(workerUrl, { type: 'module' })
	URL.revokeObjectURL(workerUrl)
	const terminate = (): void => {
		worker.terminate()
		URL.revokeObjectURL(appUrl)
	}
	const { sandbox, fail } = sandboxClient({
		post: (message) => worker.postMessage(message),
		onMessage: (handler) => {
			worker.onmessage = (event: MessageEvent) => handler(event.data)
		}
	})
	worker.onerror = (event) => {
		onDead()
		fail(new Error(event.message || 'sandbox worker error'))
		terminate()
	}
	return { sandbox, terminate }
}
