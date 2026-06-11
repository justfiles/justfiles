// `GetSandbox` over `node:worker_threads`. The host↔isolate protocol lives in
// `@justfiles/app/sandbox` (shared with frieren's Web-Worker sandbox and the
// desktop sibling); this is only the Node transport: one worker per distinct
// bundle (content-addressed reuse), loaded from a data: URL, glued to `parentPort`.
//
// Reducer code runs here — off quayd's main thread, never in a webview — so the
// berth round-trip (dispatch → reduce → app.update) works. Idle eviction is Slice 8.

import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { GetSandbox, Sandbox } from '@justfiles/app/runtime'
import { sandboxClient, sandboxWorkerSource } from '@justfiles/app/sandbox'

const workers = new Map<string, Sandbox>()

export function nodeSandbox(): GetSandbox {
	return async ({ code }) => {
		const key = createHash('sha256').update(code).digest('hex')
		let sandbox = workers.get(key)
		if (!sandbox) {
			sandbox = createWorker(code, () => workers.delete(key))
			workers.set(key, sandbox)
		}
		return sandbox
	}
}

function createWorker(code: string, onDead: () => void): Sandbox {
	const worker = new Worker(new URL(dataUrl(sandboxWorkerSource(dataUrl(code), 'node'))))
	const { sandbox, fail } = sandboxClient({
		post: (message) => worker.postMessage(message),
		onMessage: (handler) => worker.on('message', handler)
	})
	worker.on('error', (error: Error) => {
		onDead()
		fail(error)
	})
	worker.on('exit', (exitCode) => {
		if (exitCode === 0) return
		onDead()
		fail(new Error(`sandbox worker exited: ${exitCode}`))
	})
	return sandbox
}

function dataUrl(source: string): string {
	return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}
