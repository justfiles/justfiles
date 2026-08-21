import { expect, test } from 'vitest'
import { toBase64Url } from './secret'
import { tokenCodec } from './token'

const key = (fill: number) => toBase64Url(new Uint8Array(32).fill(fill))

test('seals a token for one user and token kind', async () => {
	const codec = tokenCodec(key(1))
	const sealed = await codec.seal('oauth-token', 'user_1', 'access')

	expect(sealed).toMatch(/^v1\./)
	expect(sealed).not.toContain('oauth-token')
	expect(await codec.open(sealed, 'user_1', 'access')).toBe('oauth-token')
	await expect(codec.open(sealed, 'user_2', 'access')).rejects.toThrow()
	await expect(codec.open(sealed, 'user_1', 'refresh')).rejects.toThrow()
	await expect(tokenCodec(key(2)).open(sealed, 'user_1', 'access')).rejects.toThrow()
})

test('rejects a changed or unsupported envelope', async () => {
	const codec = tokenCodec(key(1))
	const sealed = await codec.seal('oauth-token', 'user_1', 'access')
	const [version, iv, ciphertext] = sealed.split('.')
	if (!version || !iv || !ciphertext) throw new Error('test token is not sealed')
	const changed = [
		version,
		iv,
		`${ciphertext.startsWith('A') ? 'B' : 'A'}${ciphertext.slice(1)}`
	].join('.')

	await expect(codec.open(changed, 'user_1', 'access')).rejects.toThrow()
	await expect(codec.open(sealed.replace('v1.', 'v2.'), 'user_1', 'access')).rejects.toThrow(
		'unsupported sealed token'
	)
	expect(() => tokenCodec(toBase64Url(new Uint8Array(31)))).toThrow(
		'TOKEN_SEAL_KEY_V1 must contain 32 bytes'
	)
})
