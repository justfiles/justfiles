import { memStorage, volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { type Account, type SecretCodec, volumeAccountStore } from './account.ts'

const account = (over: Partial<Account> = {}): Account => ({
	id: 'u@openai.com',
	provider: 'chatgpt',
	creds: { access: 'tok', refresh: 'ref' },
	...over
})

describe('volumeAccountStore', () => {
	test('round-trips accounts and lists them; delete removes one', async () => {
		const store = volumeAccountStore(volume(memStorage()))
		expect(await store.list()).toEqual([])

		const a = account({ scopes: ['openid'] })
		await store.put(a)
		expect(await store.get('u@openai.com')).toEqual(a)
		expect(await store.list()).toEqual([a])

		await store.delete('u@openai.com')
		expect(await store.get('u@openai.com')).toBeUndefined()
		expect(await store.list()).toEqual([])
	})

	test('get is undefined for an unknown account', async () => {
		const store = volumeAccountStore(volume(memStorage()))
		expect(await store.get('nobody')).toBeUndefined()
	})

	test('ignores pre-registry records ({ accountId, providerId }) at the same path', async () => {
		// A legacy install wrote this shape into /system/accounts; read as the current
		// schema it would yield { id: undefined, provider: undefined }. It must be
		// treated as absent so callers can reseed / re-connect over it.
		const fs = volume(memStorage())
		await fs.mkdir('/system/accounts', { recursive: true })
		await fs.writeFile(
			'/system/accounts/legacy.json',
			new TextEncoder().encode(
				JSON.stringify({
					accountId: 'legacy',
					providerId: 'legacy',
					creds: {},
					enabled: { ai: {} }
				})
			)
		)
		const store = volumeAccountStore(fs)
		expect(await store.list()).toEqual([])
		expect(await store.get('legacy')).toBeUndefined()
	})

	test('secretCodec transforms only the creds lane on disk; reads decode it back', async () => {
		const fs = volume(memStorage())
		const codec: SecretCodec = {
			encode: (creds) => ({ sealed: JSON.stringify(creds) }),
			decode: (raw) => JSON.parse((raw as { sealed: string }).sealed)
		}
		const store = volumeAccountStore(fs, { secretCodec: codec })
		const a = account()
		await store.put(a)

		const onDisk = JSON.parse(
			new TextDecoder().decode(await fs.readFile('/system/accounts/u%40openai.com.json'))
		)
		expect(onDisk.creds).toEqual({ sealed: JSON.stringify(a.creds) })
		expect(onDisk.id).toBe('u@openai.com')
		expect(onDisk.provider).toBe('chatgpt')

		expect(await store.get('u@openai.com')).toEqual(a)
	})
})
