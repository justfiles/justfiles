import { expect, test } from 'vitest'
import { defineCapability, type Stream } from './core.ts'
import { implementCapability } from './implement.ts'
import type { CapabilityCall } from './types.ts'

const call = (
	capability: string,
	method: string,
	input: unknown,
	x?: Partial<CapabilityCall>
): CapabilityCall => ({ appId: 'app', capability, method, input, scopes: [], ...x })

const greet = defineCapability<
	'greet',
	{ hello(i: { name: string }): string },
	{ ticks(i: Record<never, never>): Stream<number> }
>('greet')

test('a unary method routes via invoke(input, ctx)', async () => {
	const cap = implementCapability(greet, {
		hello: ({ name }, ctx) => `hi ${name} (${ctx.appId})`,
		ticks: (_i, emit) => {
			const id = setInterval(() => emit(1), 1)
			return () => clearInterval(id)
		}
	})
	expect(await cap.invoke(call('greet', 'hello', { name: 'x' }, { appId: 'a' }))).toBe('hi x (a)')
})

test('a stream method routes via subscribe(input, emit, ctx) and returns the teardown', async () => {
	let stopped = false
	const cap = implementCapability(greet, {
		hello: ({ name }) => name,
		ticks: (_i, emit) => {
			const id = setInterval(() => emit(1), 1)
			return () => {
				clearInterval(id)
				stopped = true
			}
		}
	})
	const got: number[] = []
	const unsub = await cap.subscribe(call('greet', 'ticks', {}), (e) => got.push(e as number))
	await new Promise((r) => setTimeout(r, 5))
	unsub()
	expect(stopped).toBe(true)
	expect(got.length).toBeGreaterThan(0)
})

test('an unknown method rejects with CAPABILITY_UNAVAILABLE', async () => {
	const cap = implementCapability(greet, {
		hello: ({ name }) => name,
		ticks: (_i, emit) => {
			emit(0)
			return () => {}
		}
	})
	await expect(cap.invoke(call('greet', 'nope', {}))).rejects.toMatchObject({
		code: 'CAPABILITY_UNAVAILABLE',
		capability: 'greet',
		method: 'nope'
	})
})
