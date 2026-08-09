import { memStorage, volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { type Account, type SecretCodec, volumeAccountStore } from './account.ts'
import { aesGcmSecretCodec } from './secret-codec.ts'

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
			new TextDecoder().decode(await fs.readFile('/private/accounts/u%40openai.com.json'))
		)
		expect(onDisk.creds).toEqual({ sealed: JSON.stringify(a.creds) })
		expect(onDisk.id).toBe('u@openai.com')
		expect(onDisk.provider).toBe('chatgpt')

		expect(await store.get('u@openai.com')).toEqual(a)
	})

	test('does not persist plaintext when credential encoding fails', async () => {
		const fs = volume(memStorage())
		const store = volumeAccountStore(fs, {
			secretCodec: {
				decode: (raw) => raw,
				encode: () => {
					throw new Error('key unavailable')
				}
			}
		})

		await expect(store.put(account({ creds: { password: 'PLAINTEXT' } }))).rejects.toThrow(
			'key unavailable'
		)
		expect(await fs.exists('/private/accounts/u%40openai.com.json')).toBe(false)
	})

	test('an encrypting codec leaves no credential in the bytes on disk', async () => {
		const fs = volume(memStorage())
		const store = volumeAccountStore(fs, { secretCodec: aesGcmSecretCodec('host-key') })
		const a = account({
			creds: { access: 'ACCESS-SECRET-DO-NOT-PERSIST', refresh: 'REFRESH-SECRET-DO-NOT-PERSIST' }
		})
		await store.put(a)

		const bytes = new TextDecoder().decode(
			await fs.readFile('/private/accounts/u%40openai.com.json')
		)
		expect(bytes).not.toContain('REFRESH-SECRET-DO-NOT-PERSIST')
		expect(bytes).not.toContain('ACCESS-SECRET-DO-NOT-PERSIST')
		expect(JSON.parse(bytes)).toMatchObject({
			provider: 'chatgpt',
			creds: { v: 1, alg: 'A256GCM' }
		})
		expect(await store.get('u@openai.com')).toEqual(a)
	})

	test('with no key at all, a sealed record is unreadable — never handed out sealed', async () => {
		const fs = volume(memStorage())
		await volumeAccountStore(fs, { secretCodec: aesGcmSecretCodec('gone') }).put(account())
		const [only] = await volumeAccountStore(fs).list()
		expect(only).toMatchObject({ id: 'u@openai.com', provider: 'chatgpt' })
		expect(only.creds).toBeUndefined()
		expect(only.lastError).toBeTruthy()
	})

	test('a write that carries unreadable creds keeps the sealed bytes', async () => {
		// A key missing only for NOW (deployed before the secret was set, a mistyped
		// rotation) must not make an ordinary write destructive: Settings toggling a
		// capability off writes back the creds it was handed, which is `undefined` here.
		const fs = volume(memStorage())
		const sealed = volumeAccountStore(fs, { secretCodec: aesGcmSecretCodec('real-key') })
		await sealed.put(account({ scopes: ['openid'] }))

		const blind = volumeAccountStore(fs)
		const broken = await blind.get('u@openai.com')
		expect(broken?.creds).toBeUndefined()
		await blind.put({ id: broken!.id, provider: broken!.provider, creds: broken!.creds })

		// The key comes back and the credential is still there — untouched, still sealed.
		expect(await sealed.get('u@openai.com')).toMatchObject({ creds: account().creds })
	})

	test('reseal seals what is in the clear, and rewrites nothing else', async () => {
		// The lane a lazy "encrypt on next write" never reaches: an iCloud app-specific
		// password is written once, at connect, and no provider persists rotated creds today.
		const fs = volume(memStorage())
		const clear = volumeAccountStore(fs)
		await clear.put(account({ id: 'u@me.com', provider: 'icloud', creds: { password: 'APPSPEC' } }))
		const store = volumeAccountStore(fs, { secretCodec: aesGcmSecretCodec('real-key') })
		await store.put(account())

		const path = '/private/accounts/u%40openai.com.json'
		const sealedBefore = await fs.readFile(path)
		await store.reseal()

		const icloud = new TextDecoder().decode(await fs.readFile('/private/accounts/u%40me.com.json'))
		expect(icloud).not.toContain('APPSPEC')
		expect(JSON.parse(icloud).creds).toMatchObject({ v: 1, alg: 'A256GCM' })
		expect(await store.get('u@me.com')).toMatchObject({ creds: { password: 'APPSPEC' } })
		// An already-sealed record is left byte-identical: a boot with nothing to do writes nothing.
		expect(await fs.readFile(path)).toEqual(sealedBefore)
	})

	test('reseal never touches a record it cannot open', async () => {
		const fs = volume(memStorage())
		const old = { secretCodec: aesGcmSecretCodec('old-key') }
		await volumeAccountStore(fs, old).put(account())
		const path = '/private/accounts/u%40openai.com.json'
		const before = await fs.readFile(path)

		await volumeAccountStore(fs, { secretCodec: aesGcmSecretCodec('new-key') }).reseal()

		expect(await fs.readFile(path)).toEqual(before)
		expect(await volumeAccountStore(fs, old).get('u@openai.com')).toMatchObject({
			creds: account().creds
		})
	})

	test('a record this key cannot open still lists, without creds and flagged', async () => {
		// The rotated-the-key path: the account must stay visible (Settings shows it, the
		// user re-connects) and must not take the rest of the list down with it.
		const fs = volume(memStorage())
		await volumeAccountStore(fs, { secretCodec: aesGcmSecretCodec('old-key') }).put(account())
		const store = volumeAccountStore(fs, { secretCodec: aesGcmSecretCodec('new-key') })
		await store.put(account({ id: 'me@gmail.com', provider: 'google', creds: { access: 'g' } }))

		const list = await store.list()
		expect(list.map((a) => `${a.id}:${a.provider}`).sort()).toEqual([
			'me@gmail.com:google',
			'u@openai.com:chatgpt'
		])
		const broken = list.find((a) => a.id === 'u@openai.com')
		expect(broken?.creds).toBeUndefined()
		expect(broken?.lastError).toBeTruthy()
		expect(list.find((a) => a.id === 'me@gmail.com')?.creds).toEqual({ access: 'g' })
	})
})
