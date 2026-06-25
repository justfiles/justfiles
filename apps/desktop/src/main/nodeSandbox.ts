import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { GetSandbox, Sandbox } from '@justfiles/app/runtime'
import { sandboxClient, sandboxWorkerSource } from '@justfiles/app/sandbox'

// `GetSandbox` over `node:worker_threads`. The host↔isolate protocol lives in
// `@justfiles/app/sandbox` (shared with frieren's Web-Worker sandbox); this is
// only the Node transport: one worker per distinct bundle (content-addressed
// reuse), loaded from a data: URL, with the wire glued to `parentPort`. The app
// bundle is self-contained (the reducer compile bundles its SDK), so there is no
// spawn-time link step.

type WorkerClient = { sandbox: Sandbox; terminate: () => void }

// One worker per bundle (content hash); `appWorkers` maps an app id to its
// current bundle key so the host can `terminateAppWorker` when the app's last
// window closes — mirroring frieren's browserSandbox so long-running sessions
// don't leak a live thread per bundle ever launched.
const workers = new Map<string, WorkerClient>()
const appWorkers = new Map<string, string>()

export function nodeSandbox(): GetSandbox {
	return async ({ appId, code }) => {
		const key = cacheKey(code)
		appWorkers.set(appId, key)
		return workerFor(key, code).sandbox
	}
}

// Terminate the worker backing `appId` so its thread is reclaimed.
export function terminateAppWorker(appId: string): void {
	const key = appWorkers.get(appId)
	if (!key) return
	appWorkers.delete(appId)
	const client = workers.get(key)
	workers.delete(key)
	client?.terminate()
}

function workerFor(key: string, code: string): WorkerClient {
	let client = workers.get(key)
	if (!client) {
		client = createWorker(code, () => workers.delete(key))
		workers.set(key, client)
	}
	return client
}

function cacheKey(code: string): string {
	return createHash('sha256').update(code).digest('hex')
}

function createWorker(code: string, onDead: () => void): WorkerClient {
	const source = sandboxWorkerSource(dataUrl(code), 'node')
	const worker = new Worker(new URL(dataUrl(source)))
	const { sandbox, fail } = sandboxClient({
		post: (message) => worker.postMessage(message),
		onMessage: (handler) => worker.on('message', handler)
	})
	worker.on('error', (error) => {
		onDead()
		fail(error)
	})
	worker.on('exit', (exitCode) => {
		if (exitCode === 0) return
		onDead()
		fail(new Error(`sandbox worker exited: ${exitCode}`))
	})
	return { sandbox, terminate: () => void worker.terminate() }
}

function dataUrl(source: string): string {
	return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}
