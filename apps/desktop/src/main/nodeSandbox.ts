import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { GetSandbox, Sandbox } from '@justfiles/app/runtime'
import { sandboxClient, sandboxWorkerSource } from '@justfiles/app/sandbox'

// `GetSandbox` over `node:worker_threads`. The host↔isolate protocol lives in
// `@justfiles/app/sandbox` (shared with frieren's Web-Worker sandbox); this is
// only the Node transport: one worker per distinct bundle (content-addressed
// reuse), loaded from a data: URL, with the wire glued to `parentPort`.

const workers = new Map<string, Promise<Sandbox>>()

export function nodeSandbox(): GetSandbox {
	return async ({ code }) => workerFor(cacheKey(code), code)
}

function cacheKey(code: string): string {
	return createHash('sha256').update(code).digest('hex')
}

function workerFor(key: string, code: string): Promise<Sandbox> {
	let sandbox = workers.get(key)
	if (!sandbox) {
		sandbox = Promise.resolve(createWorker(code, () => workers.delete(key)))
		workers.set(key, sandbox)
	}
	return sandbox
}

function createWorker(code: string, onDead: () => void): Sandbox {
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
	return sandbox
}

function dataUrl(source: string): string {
	return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}
