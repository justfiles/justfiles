import { CommandRegistry } from '@justfiles/agent'
import { describe, expect, test } from 'vitest'
import type { KvStorage } from '../integrations/storage.ts'
import { activatingStore, CommandActivator } from './commands.ts'
import { buildProviders } from './providers.ts'
import { accountsStore } from './store.ts'

const KEY = 'test-encryption-key'

function memKv(): KvStorage {
	const map = new Map<string, unknown>()
	return {
		get: async <T>(k: string) => map.get(k) as T | undefined,
		put: async <T>(k: string, v: T) => void map.set(k, v),
		delete: async (k: string) => map.delete(k),
		list: async <T>(opts?: { prefix?: string }) => {
			const out = new Map<string, T>()
			for (const [k, v] of map) if (!opts?.prefix || k.startsWith(opts.prefix)) out.set(k, v as T)
			return out
		}
	}
}

describe('frieren accounts store', () => {
	test('encrypts creds at rest and round-trips through get/list', async () => {
		const store = accountsStore(memKv(), KEY)
		await store.put({
			accountId: 'fastmail',
			providerId: 'fastmail',
			creds: { token: 'secret' },
			enabled: { email: {} }
		})
		expect(await store.get('fastmail')).toMatchObject({
			accountId: 'fastmail',
			providerId: 'fastmail',
			creds: { token: 'secret' },
			enabled: { email: {} }
		})
		expect((await store.list()).map((a) => a.accountId)).toEqual(['fastmail'])
	})

	test('the persisted record never carries the secret in the clear', async () => {
		const kv = memKv()
		await accountsStore(kv, KEY).put({
			accountId: 'fastmail',
			providerId: 'fastmail',
			creds: { token: 'secret' },
			enabled: {}
		})
		const raw = JSON.stringify([...(await kv.list()).values()], (_k, v) =>
			v instanceof Uint8Array ? '<cipher>' : v
		)
		expect(raw).not.toContain('secret')
	})
})

describe('command activator', () => {
	function setup() {
		const commands = new CommandRegistry()
		const { commands: factories } = buildProviders({ getTimezone: () => 'UTC' })
		const activator = new CommandActivator({ commands, factories })
		const store = activatingStore(accountsStore(memKv(), KEY), activator)
		return { commands, store }
	}

	test('enabling a capability registers its agent command; disabling unregisters it', async () => {
		const { commands, store } = setup()
		const acct = { accountId: 'fastmail', providerId: 'fastmail', creds: { token: 't' } }
		await store.put({ ...acct, enabled: {} })
		expect(commands.lookup('fastmail')).toBeUndefined()
		await store.put({ ...acct, enabled: { email: {} } })
		expect(commands.lookup('fastmail')).toBeDefined()
		await store.put({ ...acct, enabled: {} })
		expect(commands.lookup('fastmail')).toBeUndefined()
	})

	test('disconnect unregisters the account commands', async () => {
		const { commands, store } = setup()
		await store.put({
			accountId: 'icloud',
			providerId: 'icloud',
			creds: { username: 'u', password: 'p' },
			enabled: { calendar: {} }
		})
		expect(commands.lookup('icloud-calendar')).toBeDefined()
		await store.delete('icloud')
		expect(commands.lookup('icloud-calendar')).toBeUndefined()
	})

	test('hydrate re-activates enabled accounts on boot', async () => {
		const commands = new CommandRegistry()
		const { commands: factories } = buildProviders({ getTimezone: () => 'UTC' })
		const activator = new CommandActivator({ commands, factories })
		const base = accountsStore(memKv(), KEY)
		await base.put({
			accountId: 'fastmail',
			providerId: 'fastmail',
			creds: { token: 't' },
			enabled: { email: {} }
		})
		expect(commands.lookup('fastmail')).toBeUndefined()
		await activator.hydrate(base)
		expect(commands.lookup('fastmail')).toBeDefined()
	})
})
