import { afterEach, beforeEach, expect, test, vi } from 'vitest'

type WorkerEvent = { data?: unknown; error?: unknown; message?: string }

class FakeWorker {
	static instances: FakeWorker[] = []
	readonly handlers = new Map<string, Array<(event: WorkerEvent) => void>>()
	reply = true
	terminated = false

	constructor() {
		FakeWorker.instances.push(this)
	}

	postMessage(message: unknown): void {
		if (!this.reply) return
		const request = message as { kind: string; id: string; op: string }
		if (request.kind !== 'run') return
		queueMicrotask(() =>
			this.emit('message', {
				data: {
					kind: 'result',
					id: request.id,
					ok: true,
					result: request.op === 'compile' ? { outputs: [], diagnostics: [] } : { diagnostics: [] }
				}
			})
		)
	}

	addEventListener(type: string, handler: (event: WorkerEvent) => void): void {
		const handlers = this.handlers.get(type) ?? []
		handlers.push(handler)
		this.handlers.set(type, handlers)
	}

	emit(type: string, event: WorkerEvent): void {
		for (const handler of this.handlers.get(type) ?? []) handler(event)
	}

	terminate(): void {
		this.terminated = true
	}
}

beforeEach(() => {
	vi.resetModules()
	FakeWorker.instances = []
	vi.stubGlobal('Worker', FakeWorker)
})

afterEach(() => vi.unstubAllGlobals())

test('starts lazily, restarts after failure, and stops on teardown', async () => {
	const { frierenCompile, resetDevkitWorker } = await import('./devkit.client.ts')
	const input = { files: {}, entries: {}, tsconfig: {} }
	expect(FakeWorker.instances).toHaveLength(0)

	await frierenCompile(input, {})
	expect(FakeWorker.instances).toHaveLength(1)
	const first = FakeWorker.instances[0]!
	first.reply = false
	const pending = frierenCompile(input, {})
	first.emit('error', { error: new Error('worker failed'), message: 'worker failed' })
	await expect(pending).rejects.toThrow('worker failed')
	expect(first.terminated).toBe(true)

	await frierenCompile(input, {})
	expect(FakeWorker.instances).toHaveLength(2)
	resetDevkitWorker()
	expect(FakeWorker.instances[1]?.terminated).toBe(true)
})
