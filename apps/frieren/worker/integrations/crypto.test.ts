import { describe, expect, test } from 'bun:test'
import { decrypt, encrypt } from './crypto.ts'

describe('crypto', () => {
	test('encrypt then decrypt round-trips with the same key', async () => {
		const key = 'some-32-byte-or-arbitrary-secret-string'
		const cipher = await encrypt('hello world', key)
		expect(cipher).toBeInstanceOf(Uint8Array)
		const plain = await decrypt(cipher, key)
		expect(plain).toBe('hello world')
	})

	test('different invocations produce different ciphertexts (random IV)', async () => {
		const key = 'k'
		const a = await encrypt('payload', key)
		const b = await encrypt('payload', key)
		expect(a).not.toEqual(b)
	})

	test('decrypting with the wrong key throws', async () => {
		const cipher = await encrypt('secret', 'right-key')
		await expect(decrypt(cipher, 'wrong-key')).rejects.toThrow()
	})

	test('tampered ciphertext throws', async () => {
		const cipher = await encrypt('secret', 'k')
		cipher[cipher.length - 1] ^= 0x01
		await expect(decrypt(cipher, 'k')).rejects.toThrow()
	})

	test('encrypts JSON-serialised payloads', async () => {
		const payload = JSON.stringify({ token: 'abc', refresh: 'def' })
		const cipher = await encrypt(payload, 'k')
		expect(await decrypt(cipher, 'k')).toBe(payload)
	})
})
