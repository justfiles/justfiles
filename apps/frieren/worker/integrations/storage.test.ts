import { describe, expect, test } from 'bun:test'
import { ConnectionStore, type CredentialRecord, type KvStorage } from './storage.ts'

function memStorage(): KvStorage {
	const map = new Map<string, unknown>()
	return {
		async get<T>(key: string) {
			return map.get(key) as T | undefined
		},
		async put<T>(key: string, value: T) {
			map.set(key, value)
		},
		async delete(key: string) {
			return map.delete(key)
		},
		async list<T>(opts?: { prefix?: string }) {
			const out = new Map<string, T>()
			for (const [key, value] of map) {
				if (!opts?.prefix || key.startsWith(opts.prefix)) {
					out.set(key, value as T)
				}
			}
			return out
		}
	}
}

const KEY = 'test-key'

const staticCreds: CredentialRecord = { kind: 'static', static: { token: 'abc' } }

describe('ConnectionStore', () => {
	test('put + get round-trips, decrypting creds', async () => {
		const store = new ConnectionStore(memStorage(), KEY)
		await store.put({
			integrationId: 'fastmail',
			accountId: 'personal',
			creds: staticCreds
		})
		const got = await store.get('fastmail', 'personal')
		expect(got).toMatchObject({
			integrationId: 'fastmail',
			accountId: 'personal',
			creds: staticCreds
		})
		expect(typeof got?.enabledAt).toBe('number')
	})

	test('get on missing returns undefined', async () => {
		const store = new ConnectionStore(memStorage(), KEY)
		expect(await store.get('fastmail', 'nope')).toBeUndefined()
	})

	test('creds are encrypted at rest (raw storage entry has no plaintext token)', async () => {
		const kv = memStorage()
		const store = new ConnectionStore(kv, KEY)
		await store.put({
			integrationId: 'fastmail',
			accountId: 'personal',
			creds: { kind: 'static', static: { token: 'PLAIN_TOKEN_42' } }
		})
		const raw = await kv.list<{ cipher: Uint8Array }>({ prefix: 'connections/' })
		const [entry] = [...raw.values()]
		expect(entry.cipher).toBeInstanceOf(Uint8Array)
		const text = new TextDecoder().decode(entry.cipher)
		expect(text).not.toContain('PLAIN_TOKEN_42')
	})

	test('decrypting with the wrong key throws', async () => {
		const kv = memStorage()
		await new ConnectionStore(kv, 'right').put({
			integrationId: 'a',
			accountId: 'x',
			creds: staticCreds
		})
		const wrong = new ConnectionStore(kv, 'wrong')
		await expect(wrong.get('a', 'x')).rejects.toThrow()
	})

	test('delete removes the connection', async () => {
		const store = new ConnectionStore(memStorage(), KEY)
		await store.put({ integrationId: 'a', accountId: 'x', creds: staticCreds })
		await store.delete('a', 'x')
		expect(await store.get('a', 'x')).toBeUndefined()
	})

	test('list returns all connections', async () => {
		const store = new ConnectionStore(memStorage(), KEY)
		await store.put({ integrationId: 'fastmail', accountId: 'personal', creds: staticCreds })
		await store.put({ integrationId: 'fastmail', accountId: 'work', creds: staticCreds })
		await store.put({ integrationId: 'gh', accountId: 'main', creds: staticCreds })
		const all = await store.list()
		expect(all.map((c) => `${c.integrationId}/${c.accountId}`).sort()).toEqual([
			'fastmail/personal',
			'fastmail/work',
			'gh/main'
		])
	})

	test('listFor filters to one integration', async () => {
		const store = new ConnectionStore(memStorage(), KEY)
		await store.put({ integrationId: 'fastmail', accountId: 'personal', creds: staticCreds })
		await store.put({ integrationId: 'gh', accountId: 'main', creds: staticCreds })
		const fm = await store.listFor('fastmail')
		expect(fm.map((c) => c.accountId)).toEqual(['personal'])
	})

	test('setLastError persists without losing creds', async () => {
		const store = new ConnectionStore(memStorage(), KEY)
		await store.put({ integrationId: 'a', accountId: 'x', creds: staticCreds })
		await store.setLastError('a', 'x', 'oops')
		const got = await store.get('a', 'x')
		expect(got?.lastError).toBe('oops')
		expect(got?.creds).toEqual(staticCreds)
	})

	test('setLastError clears the error when message is undefined', async () => {
		const store = new ConnectionStore(memStorage(), KEY)
		await store.put({ integrationId: 'a', accountId: 'x', creds: staticCreds })
		await store.setLastError('a', 'x', 'oops')
		await store.setLastError('a', 'x', undefined)
		const got = await store.get('a', 'x')
		expect(got?.lastError).toBeUndefined()
	})
})
