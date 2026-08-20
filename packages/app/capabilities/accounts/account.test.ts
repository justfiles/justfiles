import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { describe, expect, test } from 'vitest'
import { type Account, type AccountStore, type SecretCodec, volumeAccountStore } from './account.ts'
import { aesGcmSecretCodec } from './secret-codec.ts'

const account = (over: Partial<Account> = {}): Account => ({
	id: 'u@openai.com',
	provider: 'chatgpt',
	creds: { access: 'tok', refresh: 'ref' },
	...over
})

// `update` is the only write, so "just store this record" is the change that ignores what
// was there. Every test that isn't about the read/decide/write itself uses this.
const put = (store: AccountStore, a: Account): Promise<void> => store.update(a.id, () => a)

describe('volumeAccountStore', () => {
	test('round-trips accounts and lists them; delete removes one', async () => {
		const store = volumeAccountStore(volume(memStore()))
		expect(await store.list()).toEqual([])

		const a = account({ scopes: ['openid'] })
		await put(store, a)
		expect(await store.get('u@openai.com')).toEqual(a)
		expect(await store.list()).toEqual([a])

		await store.delete('u@openai.com')
		expect(await store.get('u@openai.com')).toBeUndefined()
		expect(await store.list()).toEqual([])
	})

	test('get is undefined for an unknown account', async () => {
		const store = volumeAccountStore(volume(memStore()))
		expect(await store.get('nobody')).toBeUndefined()
	})

	test('secretCodec transforms only the creds lane on disk; reads decode it back', async () => {
		const fs = volume(memStore())
		const codec: SecretCodec = {
			encode: (creds) => ({ sealed: JSON.stringify(creds) }),
			decode: (raw) => JSON.parse((raw as { sealed: string }).sealed)
		}
		const store = volumeAccountStore(fs, { secretCodec: codec })
		const a = account()
		await put(store, a)

		const onDisk = JSON.parse(
			new TextDecoder().decode(await fs.readFile('/private/accounts/u%40openai.com.json'))
		)
		expect(onDisk.creds).toEqual({ sealed: JSON.stringify(a.creds) })
		expect(onDisk.id).toBe('u@openai.com')
		expect(onDisk.provider).toBe('chatgpt')

		expect(await store.get('u@openai.com')).toEqual(a)
	})

	test('an encrypting codec leaves no credential in the bytes on disk', async () => {
		const fs = volume(memStore())
		const store = volumeAccountStore(fs, { secretCodec: aesGcmSecretCodec('host-key') })
		const a = account()
		await put(store, a)

		const bytes = new TextDecoder().decode(
			await fs.readFile('/private/accounts/u%40openai.com.json')
		)
		expect(bytes).not.toContain('ref')
		expect(bytes).not.toContain('tok')
		expect(JSON.parse(bytes)).toMatchObject({
			provider: 'chatgpt',
			creds: { v: 1, alg: 'A256GCM' }
		})
		expect(await store.get('u@openai.com')).toEqual(a)
	})

	test('with no key at all, a sealed record is unreadable — never handed out sealed', async () => {
		const fs = volume(memStore())
		await put(volumeAccountStore(fs, { secretCodec: aesGcmSecretCodec('gone') }), account())
		const [only] = await volumeAccountStore(fs).list()
		expect(only).toMatchObject({ id: 'u@openai.com', provider: 'chatgpt' })
		expect(only.creds).toBeUndefined()
		expect(only.lastError).toBeTruthy()
	})

	test('a write that carries unreadable creds keeps the sealed bytes', async () => {
		// A key missing only for NOW (deployed before the secret was set, a mistyped
		// rotation) must not make an ordinary write destructive: Settings toggling a
		// capability off writes back the creds it was handed, which is `undefined` here.
		const fs = volume(memStore())
		const sealed = volumeAccountStore(fs, { secretCodec: aesGcmSecretCodec('real-key') })
		await put(sealed, account({ scopes: ['openid'] }))

		const blind = volumeAccountStore(fs)
		const broken = await blind.get('u@openai.com')
		expect(broken?.creds).toBeUndefined()
		await put(blind, { id: broken!.id, provider: broken!.provider, creds: broken!.creds })

		// The key comes back and the credential is still there — untouched, still sealed.
		expect(await sealed.get('u@openai.com')).toMatchObject({ creds: account().creds })
	})

	test('reseal seals what is in the clear, and rewrites nothing else', async () => {
		// The lane a lazy "encrypt on next write" never reaches: an iCloud app-specific
		// password is written once, at connect, and no provider persists rotated creds today.
		const fs = volume(memStore())
		const clear = volumeAccountStore(fs)
		await put(
			clear,
			account({ id: 'u@me.com', provider: 'icloud', creds: { password: 'APPSPEC' } })
		)
		const store = volumeAccountStore(fs, { secretCodec: aesGcmSecretCodec('real-key') })
		await put(store, account())

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
		const fs = volume(memStore())
		const old = { secretCodec: aesGcmSecretCodec('old-key') }
		await put(volumeAccountStore(fs, old), account())
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
		const fs = volume(memStore())
		await put(volumeAccountStore(fs, { secretCodec: aesGcmSecretCodec('old-key') }), account())
		const store = volumeAccountStore(fs, { secretCodec: aesGcmSecretCodec('new-key') })
		await put(store, account({ id: 'me@gmail.com', provider: 'google', creds: { access: 'g' } }))

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

// External credential work (an OAuth exchange, a Keychain read) yields, so two operations
// on ONE account interleave inside a single host. `update` is what makes each of them a
// complete read/decide/write — the coherence every caller in host.ts then inherits.
describe('one account at a time', () => {
	const PATH = '/private/accounts/u%40openai.com.json'

	test('a read/decide/write cannot lose the update it started after', async () => {
		const store = volumeAccountStore(volume(memStore()))
		await put(store, account({ creds: { n: 0 } }))
		// Each bump reads, yields (the external call), then writes. Reading outside the chain,
		// both would see n=0 and the second write would drop the first.
		const bump = () =>
			store.update('u@openai.com', async (current) => {
				const n = (current?.creds as { n: number }).n
				await new Promise((r) => setTimeout(r, 5))
				return { ...current!, creds: { n: n + 1 } }
			})
		await Promise.all([bump(), bump()])
		expect((await store.get('u@openai.com'))?.creds).toEqual({ n: 2 })
	})

	test('a read queues behind the write in front of it, rather than catching it half-done', async () => {
		// Overwriting a file is deliberately not atomic (see `Volume.writeFile`), and on a
		// backend that fills in place a torn read parses as NO record — an account that blinks
		// out of Settings, or an active AI that resolves to nothing, while the boot reseal
		// sweep rewrites what is on disk underneath the first request.
		const store = volumeAccountStore(volume(memStore()))
		await put(store, account({ creds: { v: 'old' } }))
		let release = (): void => {}
		const parked = new Promise<void>((r) => {
			release = r
		})
		const writing = store.update('u@openai.com', async (current) => {
			await parked
			return { ...current!, creds: { v: 'new' } }
		})
		// Both issued while the write holds the chain: each must observe the completed write.
		const reading = store.get('u@openai.com')
		const listing = store.list()
		release()
		await writing

		expect((await reading)?.creds).toEqual({ v: 'new' })
		expect((await listing)[0]?.creds).toEqual({ v: 'new' })
	})

	test('a change that declines writes nothing at all', async () => {
		const fs = volume(memStore())
		const store = volumeAccountStore(fs)
		await put(store, account())
		const before = await fs.readFile(PATH)
		await store.update('u@openai.com', () => undefined)
		expect(await fs.readFile(PATH)).toEqual(before)
	})

	test('two different accounts never wait on each other', async () => {
		// The chain is per account, not per store: a sign-in parked on a browser redirect must
		// not hold up every other account (or, in the DO, the events behind it).
		const store = volumeAccountStore(volume(memStore()))
		let release = (): void => {}
		const parked = new Promise<void>((r) => {
			release = r
		})
		const slow = store.update('a', async () => {
			await parked
			return { id: 'a', provider: 'chatgpt', creds: {} }
		})
		// `b` goes all the way through — write AND read — while `a` is still parked. (Reading
		// `a` here would correctly queue behind its own write, which is the test above.)
		await store.update('b', () => ({ id: 'b', provider: 'chatgpt', creds: {} }))
		expect(await store.get('b')).toMatchObject({ id: 'b' })

		release()
		await slow
		expect(await store.get('a')).toMatchObject({ id: 'a' })
	})

	test('a credential this host cannot seal leaves the previous file untouched', async () => {
		// Fail closed: encode throwing (a locked Keychain) must not fall back to plaintext, and
		// must not destroy the record that is already there either.
		const fs = volume(memStore())
		const real = aesGcmSecretCodec('host-key')
		let sealable = true
		const codec: SecretCodec = {
			encode: (creds, id) => {
				if (!sealable) throw new Error('keychain: locked')
				return real.encode(creds, id)
			},
			decode: (raw, id) => real.decode(raw, id)
		}
		const store = volumeAccountStore(fs, { secretCodec: codec })
		await put(store, account())
		const before = await fs.readFile(PATH)

		sealable = false
		await expect(put(store, account({ creds: { access: 'NEVER-IN-THE-CLEAR' } }))).rejects.toThrow(
			'locked'
		)
		expect(new TextDecoder().decode(await fs.readFile(PATH))).not.toContain('NEVER-IN-THE-CLEAR')
		expect(await fs.readFile(PATH)).toEqual(before)
	})

	test('a mutation racing the reseal sweep is never overwritten by it', async () => {
		// The sweep scans, then publishes. Publishing what the SCAN saw would undo a write that
		// landed in between — so it re-reads the record inside that account's chain.
		const fs = volume(memStore())
		await put(volumeAccountStore(fs), account({ creds: { access: 'OLD' } }))
		const store = volumeAccountStore(fs, { secretCodec: aesGcmSecretCodec('host-key') })

		await Promise.all([
			store.reseal(),
			store.update('u@openai.com', (current) => current && { ...current, creds: { access: 'NEW' } })
		])

		expect((await store.get('u@openai.com'))?.creds).toEqual({ access: 'NEW' })
		expect(new TextDecoder().decode(await fs.readFile(PATH))).not.toContain('NEW')
	})

	test('one record it cannot seal does not strand the rest of the sweep', async () => {
		const fs = volume(memStore())
		const clear = volumeAccountStore(fs)
		await put(clear, account({ id: 'a@x', creds: { p: 'A-PW' } }))
		await put(clear, account({ id: 'b@x', creds: { p: 'B-PW' } }))
		const real = aesGcmSecretCodec('host-key')
		const codec: SecretCodec = {
			encode: (creds, id) => {
				if (id === 'a@x') throw new Error('this one will not seal')
				return real.encode(creds, id)
			},
			decode: (raw, id) => real.decode(raw, id)
		}

		// It still reports the failure — the caller's single flight has to clear and retry later.
		await expect(volumeAccountStore(fs, { secretCodec: codec }).reseal()).rejects.toThrow(
			'this one will not seal'
		)
		const read = async (id: string) =>
			new TextDecoder().decode(
				await fs.readFile(`/private/accounts/${encodeURIComponent(id)}.json`)
			)
		expect(await read('b@x')).not.toContain('B-PW')
		expect(await read('a@x')).toContain('A-PW')
	})
})
