import { expect, test } from 'bun:test'
import { Check } from 'typebox/value'
import type { App, Host } from './contract.js'
import { APP_CONTRACT_VERSION, defineApp, ManifestSchema } from './contract.js'

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false
type Expect<T extends true> = T

// Static shape checks — the contract is the API; drift here means we changed
// what app authors must implement.
type _AppMount = Expect<Equal<Parameters<App['mount']>, [HTMLElement, Host]>>
type _HostHasVersion = Expect<Equal<Host['version'], number>>

test('defineApp returns the same object', () => {
	const value: App = { id: 'x', mount: () => {}, unmount: () => {} }
	expect(defineApp(value)).toBe(value)
})

test('APP_CONTRACT_VERSION is a number', () => {
	expect(typeof APP_CONTRACT_VERSION).toBe('number')
})

test('ManifestSchema accepts a minimal valid manifest', () => {
	expect(
		Check(ManifestSchema, { id: 'hello', title: 'Hello', version: '0.1.0', entry: 'index.js' })
	).toBe(true)
})

test('ManifestSchema rejects missing required fields', () => {
	expect(Check(ManifestSchema, { id: 'hello', title: 'Hello', entry: 'index.js' })).toBe(false)
	expect(Check(ManifestSchema, { title: 'Hello', version: '0.1.0', entry: 'index.js' })).toBe(false)
})

test('ManifestSchema rejects unknown shapes', () => {
	expect(Check(ManifestSchema, null)).toBe(false)
	expect(Check(ManifestSchema, 'string')).toBe(false)
})
