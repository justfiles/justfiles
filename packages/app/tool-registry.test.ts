import { expect, test } from 'bun:test'
import Type from 'typebox'
import { createToolRegistry, ToolInvokeFailure } from './tool-registry.js'

test('register/invoke happy path passes typed input to the handler', async () => {
	const reg = createToolRegistry()
	let received: { x: number } | undefined
	reg.registry.register({
		name: 'add',
		description: 'add to x',
		schema: Type.Object({ x: Type.Number() }),
		handler(input) {
			received = input
			return input.x + 1
		}
	})
	const out = await reg.invoke('add', { x: 41 })
	expect(out).toBe(42)
	expect(received).toEqual({ x: 41 })
})

test('invoke on unknown tool throws ToolInvokeFailure { kind: unknown_tool }', async () => {
	const reg = createToolRegistry()
	let failure: ToolInvokeFailure | undefined
	try {
		await reg.invoke('missing', {})
	} catch (err) {
		failure = err as ToolInvokeFailure
	}
	expect(failure).toBeInstanceOf(ToolInvokeFailure)
	expect(failure?.detail.kind).toBe('unknown_tool')
	expect(failure?.detail.tool).toBe('missing')
})

test('invoke rejects input that fails TypeBox schema check', async () => {
	const reg = createToolRegistry()
	reg.registry.register({
		name: 'echo',
		description: 'echo',
		schema: Type.Object({ x: Type.String() }),
		handler: (input) => input.x
	})
	let failure: ToolInvokeFailure | undefined
	try {
		await reg.invoke('echo', { x: 42 })
	} catch (err) {
		failure = err as ToolInvokeFailure
	}
	expect(failure?.detail.kind).toBe('schema')
	expect(failure?.detail.tool).toBe('echo')
})

test('invoke packages thrown handler errors as { kind: handler }', async () => {
	const reg = createToolRegistry()
	reg.registry.register({
		name: 'boom',
		description: 'throws',
		schema: Type.Object({}),
		handler: () => {
			throw new Error('kaboom')
		}
	})
	let failure: ToolInvokeFailure | undefined
	try {
		await reg.invoke('boom', {})
	} catch (err) {
		failure = err as ToolInvokeFailure
	}
	expect(failure?.detail.kind).toBe('handler')
	expect(failure?.detail.message).toBe('kaboom')
})

test('register returns idempotent unregister', () => {
	let unregCount = 0
	const reg = createToolRegistry({
		onUnregister: () => {
			unregCount++
		}
	})
	const off = reg.registry.register({
		name: 't',
		description: '',
		schema: Type.Object({}),
		handler: () => null
	})
	off()
	off()
	expect(unregCount).toBe(1)
})

test('unregister removes the tool from invocation', async () => {
	const reg = createToolRegistry()
	const off = reg.registry.register({
		name: 't',
		description: '',
		schema: Type.Object({}),
		handler: () => 'ok'
	})
	expect(await reg.invoke('t', {})).toBe('ok')
	off()
	let failure: ToolInvokeFailure | undefined
	try {
		await reg.invoke('t', {})
	} catch (err) {
		failure = err as ToolInvokeFailure
	}
	expect(failure?.detail.kind).toBe('unknown_tool')
})

test('dispose clears every registered tool and fires onUnregister for each', () => {
	const removed: string[] = []
	const reg = createToolRegistry({ onUnregister: (n) => removed.push(n) })
	reg.registry.register({
		name: 'a',
		description: '',
		schema: Type.Object({}),
		handler: () => null
	})
	reg.registry.register({
		name: 'b',
		description: '',
		schema: Type.Object({}),
		handler: () => null
	})
	reg.dispose()
	expect(removed.sort()).toEqual(['a', 'b'])
	expect(reg.list()).toEqual([])
})

test('dispose is idempotent', () => {
	let count = 0
	const reg = createToolRegistry({ onUnregister: () => count++ })
	reg.registry.register({
		name: 'a',
		description: '',
		schema: Type.Object({}),
		handler: () => null
	})
	reg.dispose()
	reg.dispose()
	expect(count).toBe(1)
})

test('register after dispose throws', () => {
	const reg = createToolRegistry()
	reg.dispose()
	expect(() =>
		reg.registry.register({
			name: 'late',
			description: '',
			schema: Type.Object({}),
			handler: () => null
		})
	).toThrow(/disposed/)
})

test('onRegister fires with the registered tool descriptor', () => {
	const events: string[] = []
	const reg = createToolRegistry({ onRegister: (t) => events.push(t.name) })
	reg.registry.register({
		name: 'hello',
		description: '',
		schema: Type.Object({}),
		handler: () => null
	})
	expect(events).toEqual(['hello'])
})

test('list reflects currently registered tools', () => {
	const reg = createToolRegistry()
	reg.registry.register({
		name: 'a',
		description: 'A',
		schema: Type.Object({}),
		handler: () => null
	})
	const off = reg.registry.register({
		name: 'b',
		description: 'B',
		schema: Type.Object({}),
		handler: () => null
	})
	expect(
		reg
			.list()
			.map((t) => t.name)
			.sort()
	).toEqual(['a', 'b'])
	off()
	expect(reg.list().map((t) => t.name)).toEqual(['a'])
})
