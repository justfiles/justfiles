import { expect, test } from 'bun:test'
import { APP_CONTRACT_VERSION } from './contract.js'
import { createHost } from './host-factory.js'

test('createHost returns a Host with the contract version', () => {
	const host = createHost()
	expect(host.version).toBe(APP_CONTRACT_VERSION)
})

test('createHost yields a fresh instance per call', () => {
	const a = createHost()
	const b = createHost()
	expect(a).not.toBe(b)
})
