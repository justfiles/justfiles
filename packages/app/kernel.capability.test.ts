import { expect, test, vi } from 'vitest'
import { capabilities, type Declared } from './kernel.capability.ts'

// The capability resolver in isolation — no kernel, no sandbox, just an injected
// loader. Covers the trust-boundary lookup, per-app memoization (incl. concurrent
// first calls sharing one load), and forget-on-(re)install.

const decls = (m: Record<string, Declared>) => async () => m

test('resolves a declared local name to its trusted id and scopes', async () => {
	const caps = capabilities(decls({ volume: { id: 'volume', scopes: ['system'] } }))
	expect(await caps.resolve('app', 'volume')).toEqual({ id: 'volume', scopes: ['system'] })
	// A name the app never declared resolves to undefined (the caller errors on it).
	expect(await caps.resolve('app', 'absent')).toBeUndefined()
})

test('declarations are loaded once per app and memoized', async () => {
	const load = vi.fn(
		async (appId: string): Promise<Record<string, Declared>> => ({
			x: { id: `${appId}-x`, scopes: [] }
		})
	)
	const caps = capabilities(load)
	await caps.resolve('a', 'x')
	await caps.resolve('a', 'x')
	await caps.resolve('b', 'x')
	expect(load).toHaveBeenCalledTimes(2) // once for 'a', once for 'b'
	expect(await caps.resolve('b', 'x')).toEqual({ id: 'b-x', scopes: [] })
})

test('concurrent first resolves share a single load', async () => {
	const load = vi.fn(decls({ x: { id: 'x', scopes: [] } }))
	const caps = capabilities(load)
	await Promise.all([caps.resolve('a', 'x'), caps.resolve('a', 'x'), caps.resolve('a', 'x')])
	expect(load).toHaveBeenCalledTimes(1)
})

test('forget drops the memo so the next resolve reloads', async () => {
	const load = vi.fn(decls({ x: { id: 'x', scopes: [] } }))
	const caps = capabilities(load)
	await caps.resolve('a', 'x')
	caps.forget('a')
	await caps.resolve('a', 'x')
	expect(load).toHaveBeenCalledTimes(2)
})
