import { describe, expect, it } from 'vitest'
import type { ResolvedImports } from './imports.ts'
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

	it('runs toolchain requests one at a time', async () => {
		const [host, worker] = link()
		const calls: string[] = []
		let release!: () => void
		const blocked = new Promise<void>((resolve) => {
			release = resolve
		})
		serveToolchain(
			{
				compile: async (_input, runtime) => {
					calls.push(runtime.name ?? '')
					if (runtime.name === 'first') await blocked
					return { outputs: [], diagnostics: [] }
				}
			},
			worker
		)
		const client = toolchainClient(host)
		const first = client.compile(input, { name: 'first' })
		const second = client.compile(input, { name: 'second' })
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(calls).toEqual(['first'])
		release()
		await Promise.all([first, second])
		expect(calls).toEqual(['first', 'second'])
	})

	it('loads remote imports through the host session', async () => {
		const [host, worker] = link()
		serveToolchain(
			{
				compile: async (_input, _runtime, imports) => ({
					outputs: imports
						? [
								{
									path: 'app.js',
									text: (await imports.load(imports.resolve('example', '', 'code'))).text
								}
							]
						: [],
					diagnostics: []
				})
			},
			worker
		)
		const imports: ResolvedImports = {
			code: { example: 'https://esm.sh/example@1.0.0/example.mjs' },
			declarations: {},
			limits: { depth: 1, files: 1, fileBytes: 100, totalBytes: 100, timeoutMs: 100 },
			load: async (url) => ({ url, text: 'remote code' }),
			resolve: () => '',
			lock: () => ({ version: 1, redirects: {}, remote: {} }),
			diagnostics: []
		}

		const result = await toolchainClient(host).compile(input, {}, imports)

		expect(result.outputs[0]?.text).toBe('remote code')
	})
})
