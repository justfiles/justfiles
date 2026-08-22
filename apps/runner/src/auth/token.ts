import { fromBase64Url, toBase64Url } from './secret'

const VERSION = 1
const IV_BYTES = 12
const encoder = new TextEncoder()
const decoder = new TextDecoder()

type TokenKind = 'access' | 'refresh'

export function tokenCodec(secret: string) {
	const bytes = fromBase64Url(secret)
	if (bytes.length !== 32) throw new Error('TOKEN_SEAL_KEY_V1 must contain 32 bytes')
	const key = crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])

	return {
		async seal(token: string, userId: string, kind: TokenKind): Promise<string> {
			const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
			const ciphertext = await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv, additionalData: aad(userId, kind) },
				await key,
				encoder.encode(token)
			)
			return `v${VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`
		},
		async open(sealed: string, userId: string, kind: TokenKind): Promise<string> {
			const [version, iv, ciphertext, extra] = sealed.split('.')
			if (version !== `v${VERSION}` || !iv || !ciphertext || extra)
				throw new Error('unsupported sealed token')
			return decoder.decode(
				await crypto.subtle.decrypt(
					{
						name: 'AES-GCM',
						iv: fromBase64Url(iv),
						additionalData: aad(userId, kind)
					},
					await key,
					fromBase64Url(ciphertext)
				)
			)
		}
	}
}

export type TokenCodec = ReturnType<typeof tokenCodec>

const aad = (userId: string, kind: TokenKind): Uint8Array =>
	encoder.encode(JSON.stringify([VERSION, userId, kind]))
