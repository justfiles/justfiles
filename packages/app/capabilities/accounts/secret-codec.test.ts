import { describe, expect, test } from 'vitest'
import { aesGcmSecretCodec } from './secret-codec.ts'

const codec = aesGcmSecretCodec('a-host-key')
const creds = { access: 'tok', refresh: 'SEKRIT' }

describe('aesGcmSecretCodec', () => {
	test('round-trips creds, including an empty record', async () => {
		expect(await codec.decode(await codec.encode(creds, 'a'), 'a')).toEqual(creds)
		expect(await codec.decode(await codec.encode({}, 'a'), 'a')).toEqual({})
	})

	test('the envelope carries no plaintext, and repeats differ (random iv)', async () => {
		const one = await codec.encode(creds, 'a')
		const two = await codec.encode(creds, 'a')
		expect(JSON.stringify(one)).not.toContain('SEKRIT')
		expect(one).toMatchObject({ v: 1, alg: 'A256GCM' })
		expect(JSON.stringify(one)).not.toEqual(JSON.stringify(two))
	})

	test('the account id is bound in: another account cannot open this envelope', async () => {
		const sealed = await codec.encode(creds, 'a@example.com')
		await expect(codec.decode(sealed, 'b@example.com')).rejects.toThrow()
	})

	test('a non-envelope passes through — a plaintext record still reads', async () => {
		expect(await codec.decode({ refresh: 'plain' }, 'a')).toEqual({ refresh: 'plain' })
		expect(await codec.decode(undefined, 'a')).toBeUndefined()
	})

	test('tampered ciphertext throws, never yields partial plaintext', async () => {
		const sealed = (await codec.encode(creds, 'a')) as { v: 1; alg: string; ct: string }
		const bytes = [...atob(sealed.ct)].map((c) => c.charCodeAt(0))
		bytes[bytes.length - 1] ^= 0xff
		const ct = btoa(String.fromCharCode(...bytes))
		await expect(codec.decode({ ...sealed, ct }, 'a')).rejects.toThrow()
	})

	test('another key cannot open it', async () => {
		const sealed = await codec.encode(creds, 'a')
		await expect(aesGcmSecretCodec('another-host-key').decode(sealed, 'a')).rejects.toThrow()
	})
})
