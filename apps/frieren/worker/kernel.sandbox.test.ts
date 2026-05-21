import { defineApp } from '@justfiles/app/kernel/sdk'
import { chroot, memStorage, volume } from '@justfiles/fs'
import { expect, test } from 'vitest'
import { workerSandbox } from './kernel.sandbox'

// A real defineApp bundle: validation is framework-owned and compiled into
// the app (this is exactly the code a built app.js carries). A minimal
// Standard Schema keeps the fixture dependency-free.
const numberAmount = {
	'~standard': {
		version: 1 as const,
		vendor: 'test',
		types: undefined as unknown as { input: { amount: number }; output: { amount: number } },
		validate: (input: unknown) =>
			typeof (input as { amount?: unknown })?.amount === 'number'
				? { value: input as { amount: number } }
				: { issues: [{ message: 'expected number amount' }] }
	}
}

const app = defineApp({
	init: { count: 0 },
	handlers: {
		increment: {
			schema: numberAmount,
			handler({ amount }, ctx) {
				return { ...ctx.state, count: ctx.state.count + amount }
			}
		}
	}
})

// CODE stands in for the compiled app.js. workerd can't run in Node, so the
// fake LOADER emulates the dynamic worker: it honours the produced graph
// (mainModule + modules) and runs ENTRY's one-line `app.dispatch`
// delegation. The real `cloudflare:workers` WorkerEntrypoint / RPC path is
// exercised by running frieren (Phases 2+).
const CODE = 'export { app } /* compiled app.js */'

type WorkerCode = { mainModule: string; modules: Record<string, string>; globalOutbound: null }

const fakeLoader = () => {
	const calls: { key: string | null; code: WorkerCode }[] = []
	const loader = {
		get(key: string | null, getCode: () => Promise<WorkerCode>) {
			return {
				getEntrypoint() {
					return {
						async dispatch(action: unknown, ctx: unknown) {
							const code = await getCode()
							calls.push({ key, code })
							// faithful to ENTRY: import the app module, delegate.
							return app.dispatch(action as never, ctx as never)
						}
					}
				}
			}
		}
	}
	return { loader, calls }
}

const ctx = () => ({
	state: undefined as unknown,
	files: chroot(volume(memStorage()), '/'),
	setState: async () => {}
})

test('valid dispatch returns the parsed result and threads state', async () => {
	const { loader } = fakeLoader()
	const getSandbox = workerSandbox(loader as unknown as Parameters<typeof workerSandbox>[0])

	const sb = await getSandbox({ appId: 'test.app', code: CODE })
	expect(await sb.run({ type: 'increment', params: { amount: 5 } }, ctx())).toEqual({ count: 5 })
	expect(
		await sb.run({ type: 'increment', params: { amount: 2 } }, { ...ctx(), state: { count: 5 } })
	).toEqual({ count: 7 })
})

test('invalid params reject with the Standard Schema message from the bundle', async () => {
	const { loader } = fakeLoader()
	const getSandbox = workerSandbox(loader as unknown as Parameters<typeof workerSandbox>[0])

	const sb = await getSandbox({ appId: 'test.app', code: CODE })
	await expect(sb.run({ type: 'increment', params: { amount: 'nope' } }, ctx())).rejects.toThrow(
		/invalid params for increment/
	)
})

test('builds the dynamic-worker graph and content-addresses the isolate', async () => {
	const { loader, calls } = fakeLoader()
	const getSandbox = workerSandbox(loader as unknown as Parameters<typeof workerSandbox>[0])

	await (await getSandbox({ appId: 'test.app', code: CODE })).run(
		{ type: 'increment', params: { amount: 1 } },
		ctx()
	)
	await (await getSandbox({ appId: 'test.app', code: CODE })).run(
		{ type: 'increment', params: { amount: 1 } },
		ctx()
	)

	const [a, b] = calls
	expect(a.key).toMatch(/^kernel-[0-9a-f]{16}$/)
	expect(a.key).toBe(b.key) // identical code -> same isolate
	expect(a.code.mainModule).toBe('entry.js')
	expect(Object.keys(a.code.modules).sort()).toEqual(['app.js', 'entry.js'])
	expect(a.code.modules['app.js']).toBe(CODE)
	expect(a.code.modules['entry.js']).toMatch(/WorkerEntrypoint[\s\S]*app\.dispatch\(action, ctx\)/)
	expect(a.code.globalOutbound).toBeNull()
})
