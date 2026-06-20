import { memStorage, volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { type Account, type SecretCodec, volumeAccountsStore } from './store.ts'

// The canonical store rides a real in-memory Volume (one JSON file per account).

const account = (over: Partial<Account> = {}): Account => ({
	accountId: 'u@openai.com',
	providerId: 'chatgpt',
	creds: { access: 'tok', refresh: 'ref' },
	enabled: {},
	...over
})

describe('volumeAccountsStore', () => {
	test('round-trips accounts and lists them; delete removes one', async () => {
		const store = volumeAccountsStore(volume(memStorage()))
		expect(await store.list()).toEqual([])

		const a = account({ enabled: { ai: { model: 'gpt-x' } } })
		await store.put(a)
		expect(await store.get('u@openai.com')).toEqual(a)
		expect(await store.list()).toEqual([a])

		await store.delete('u@openai.com')
		expect(await store.get('u@openai.com')).toBeUndefined()
		expect(await store.list()).toEqual([])
	})

	test('get is undefined for an unknown account', async () => {
		const store = volumeAccountsStore(volume(memStorage()))
		expect(await store.get('nobody')).toBeUndefined()
	})

	test('secretCodec transforms only the creds lane on disk; get decodes it back', async () => {
		const fs = volume(memStorage())
		// A trivial reversible codec stands in for encryption: it tags the creds so we
		// can prove what hits disk is encoded, while get/list still hand back cleartext.
		const codec: SecretCodec = {
			encode: (creds) => ({ sealed: JSON.stringify(creds) }),
			decode: (raw) => JSON.parse((raw as { sealed: string }).sealed)
		}
		const store = volumeAccountsStore(fs, { secretCodec: codec })
		const a = account()
		await store.put(a)

		// on disk: creds replaced by the codec's output, the rest in the clear
		const onDisk = JSON.parse(
			new TextDecoder().decode(await fs.readFile('/system/accounts/u%40openai.com.json'))
		)
		expect(onDisk.creds).toEqual({ sealed: JSON.stringify(a.creds) })
		expect(onDisk.accountId).toBe('u@openai.com')

		// reads decode transparently
		expect(await store.get('u@openai.com')).toEqual(a)
	})
})
