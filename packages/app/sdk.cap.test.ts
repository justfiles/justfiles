import * as v from 'valibot'
import { expect, test, vi } from 'vitest'
import type { RawAppHandle } from './app.ts'
import { defineCapability } from './capabilities/core.ts'
import { defineApp } from './sdk.ts'

const service = defineCapability<
	'service',
	{ sum(...values: number[]): number; 'host.version'(): string }
>('service')

const app = defineApp({
	init: { count: 0 },
	capabilities: { tools: service({ scopes: [] }) },
	procedures: (p) => ({
		sum: p.procedure({
			schema: v.array(v.number()),
			run: (values, app) => app.cap.tools.sum(...values)
		}),
		inspect: p.procedure({
			schema: v.object({}),
			async run(_, app) {
				const tools = await app.cap.tools
				const { sum } = tools
				return {
					state: app.state,
					services: Object.keys(app.cap),
					invoke: 'invoke' in app,
					symbol: Reflect.get(tools, Symbol.toStringTag),
					version: await tools['host.version'](),
					total: await sum(1, 2, 3)
				}
			}
		})
	})
})

const handle = (invoke: RawAppHandle['invoke'], state?: unknown): RawAppHandle => ({
	state,
	dispatch: async () => ({ seq: 0 }),
	settled: async () => state,
	invoke
})

test('cap services can be awaited and methods detached without extra host calls', async () => {
	const invoke = vi.fn<RawAppHandle['invoke']>(async (_cap, method, ...args) =>
		method === 'host.version' ? 'v1' : args.reduce<number>((sum, n) => sum + Number(n), 0)
	)
	expect(await app.runProcedure('inspect', {}, handle(invoke))).toEqual({
		state: { count: 0 },
		services: ['tools'],
		invoke: false,
		symbol: undefined,
		version: 'v1',
		total: 6
	})
	expect(invoke.mock.calls).toEqual([
		['tools', 'host.version'],
		['tools', 'sum', 1, 2, 3]
	])
})

test('each procedure gets its own host calls and state snapshot', async () => {
	const first = vi.fn<RawAppHandle['invoke']>().mockResolvedValue(1)
	const second = vi.fn<RawAppHandle['invoke']>().mockResolvedValue(2)
	const results = await Promise.all([
		app.runProcedure('inspect', {}, handle(first, { count: 1 })),
		app.runProcedure('inspect', {}, handle(second, { count: 2 }))
	])
	expect(results).toMatchObject([
		{ state: { count: 1 }, total: 1 },
		{ state: { count: 2 }, total: 2 }
	])
	expect(first).toHaveBeenCalledTimes(2)
	expect(second).toHaveBeenCalledTimes(2)
})

test('cap calls preserve host failures and invalid procedure params never reach the host', async () => {
	const denied = new Error('capability denied')
	const invoke = vi.fn<RawAppHandle['invoke']>().mockRejectedValue(denied)
	await expect(app.runProcedure('sum', [1], handle(invoke))).rejects.toBe(denied)
	await expect(app.runProcedure('sum', 'invalid', handle(invoke))).rejects.toThrow('invalid params')
	expect(invoke).toHaveBeenCalledExactlyOnceWith('tools', 'sum', 1)
})
