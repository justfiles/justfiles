import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { GetSandbox, Sandbox } from '@justfiles/app/runtime'
import { sandboxClient, sandboxWorkerSource } from '@justfiles/app/sandbox'
import { resolveSdkExternals, SDK_SENTINEL } from '@justfiles/app/sdk-externals'

// `GetSandbox` over `node:worker_threads`. The host↔isolate protocol lives in
// `@justfiles/app/sandbox` (shared with frieren's Web-Worker sandbox); this is
// only the Node transport: one worker per distinct bundle (content-addressed
// reuse), loaded from a data: URL, with the wire glued to `parentPort`.

type WorkerClient = { sandbox: Sandbox; terminate: () => void }

// One worker per bundle (content hash); `appWorkers` maps an app id to its
// current bundle key so the host can `terminateAppWorker` when the app's last
// window closes — mirroring frieren's browserSandbox so long-running sessions
// don't leak a live thread per bundle ever launched.
const workers = new Map<string, WorkerClient>()
const appWorkers = new Map<string, string>()
// One data: module URL per SDK spec, built on first use and reused for the process life.
const sdkUrls = new Map<string, string>()

export function nodeSandbox(sdk?: () => Promise<Map<string, string>>): GetSandbox {
	return async ({ appId, code }) => {
		const key = cacheKey(code)
		appWorkers.set(appId, key)
		return workerFor(key, await link(code, sdk)).sandbox
	}
}

// Rewrite the reducer's `justfiles-sdk:` sentinels to data: URLs of the host's in-memory
// SDK (the worker has no importmap). No sentinel → no SDK load. Desktop's vendor-source
// wiring is deferred (Step 1), so today `sdk` is unset and this passes code through.
async function link(code: string, sdk?: () => Promise<Map<string, string>>): Promise<string> {
	if (!sdk || !code.includes(SDK_SENTINEL)) return code
	const sources = await sdk()
	return resolveSdkExternals(code, (spec) => {
		let url = sdkUrls.get(spec)
		if (!url) {
			const src = sources.get(spec)
			if (src === undefined) throw new Error(`sandbox: no SDK module for "${spec}"`)
			url = dataUrl(src)
			sdkUrls.set(spec, url)
		}
		return url
	})
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
