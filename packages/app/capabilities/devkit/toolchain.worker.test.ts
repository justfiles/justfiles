import { describe, expect, it } from 'vitest'
import type { CheckResult, CompileResult, ProjectInput } from './toolchain.ts'
import { serveToolchain, type ToolchainTransport, toolchainClient } from './toolchain.worker.ts'

// A linked transport pair: a frame posted on one side is delivered to the other's
// handler on a microtask (mirrors postMessage's async delivery, sync-free). This
// stands in for the Worker boundary so the RPC core is testable off any thread.
function link(): [ToolchainTransport, ToolchainTransport] {
	const handlers: { a?: (m: unknown) => void; b?: (m: unknown) => void } = {}
	const deliver = (to: ((m: unknown) => void) | undefined, m: unknown) =>
		queueMicrotask(() => to?.(m))
	return [
		{
			post: (m) => deliver(handlers.b, m),
			onMessage: (h) => {
				handlers.a = h
			}
		},
		{
			post: (m) => deliver(handlers.a, m),
			onMessage: (h) => {
				handlers.b = h
			}
		}
	]
}

const input = { files: {}, entries: {}, tsconfig: {} } as unknown as ProjectInput

describe('toolchain worker RPC', () => {
	it('routes compile + typecheck to the backends and returns their results', async () => {
		const [host, worker] = link()
		serveToolchain(
			{
				compile: async (_input, runtime) => ({
					outputs: [{ path: 'app.js', text: `js:${Object.keys(runtime).length}` }],
					diagnostics: []
				}),
				typecheck: async () => ({ diagnostics: [{ message: 'x' }] }) as unknown as CheckResult
			},
			worker
		)
		const client = toolchainClient(host)

		const compiled = (await client.compile(input, { r: '1' })) as CompileResult
		expect(compiled.outputs[0]?.text).toBe('js:1')
		const checked = await client.typecheck(input, {}, {})
		expect(checked.diagnostics).toHaveLength(1)
	})

	it('propagates a backend throw as a rejected promise', async () => {
		const [host, worker] = link()
		serveToolchain(
			{
				compile: async () => {
					throw new Error('boom')
				}
			},
			worker
		)
		await expect(toolchainClient(host).compile(input, {})).rejects.toThrow('boom')
	})

	it('rejects typecheck when the worker has no typecheck backend', async () => {
		const [host, worker] = link()
		serveToolchain({ compile: async () => ({ outputs: [], diagnostics: [] }) }, worker)
		await expect(toolchainClient(host).typecheck(input, {}, {})).rejects.toThrow(/no typecheck/)
	})

	it('fail() rejects every in-flight call (a dead worker is never awaited forever)', async () => {
		const [host] = link() // no server attached → calls hang until we fail them
		const client = toolchainClient(host)
		const pending = client.compile(input, {})
		client.fail(new Error('worker died'))
		await expect(pending).rejects.toThrow('worker died')
	})
})
