// AES-256-GCM value encryption for the ONE encryptable lane of an account record:
// `creds`. `id`/`provider`/`scopes` stay clear, so `list` projects an account (and
// Settings renders it) without a key, and the file stays diffable — SOPS-shaped.
//
// The key never lives in the tree it protects: each host holds its own outside the
// Volume (frieren a Worker secret, mac the Keychain). That is what this buys —
// a SQLite dump, an R2 object, a backup, a stray log all become useless. It buys
// nothing against a compromised host, which is deliberate: the host must be able to
// USE the creds with no client online (refresh a token, run the 4am alarm), so E2EE
// is off the table (see #290 D3/D4).
//
// The envelope is self-describing, so migration needs no flag day: `decode` returns a
// non-envelope value UNCHANGED, so a pre-encryption plaintext record keeps working and
// gets sealed on its next `put` (every token refresh does one).

import type { SecretCodec } from './account.ts'

const IV_BYTES = 12
const ALG = 'A256GCM'
const INFO = 'justfiles/accounts/v1'
const enc = new TextEncoder()
const dec = new TextDecoder()

interface Envelope {
	v: 1
	alg: typeof ALG
	ct: string // base64(iv ‖ ciphertext‖tag)
}

const isEnvelope = (raw: unknown): raw is Envelope => {
	const e = raw as Envelope | null
	return (
		typeof e === 'object' && e !== null && e.v === 1 && e.alg === ALG && typeof e.ct === 'string'
	)
}

// HKDF-SHA256 rather than a bare hash of the secret: the secret is a passphrase-shaped
// string, and a fixed `info` domain-separates this use from any other thing the same
// secret might key.
async function deriveKey(secret: string): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, [
		'deriveKey'
	])
	return crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(INFO) },
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	)
}

function toBase64(bytes: Uint8Array): string {
	let s = ''
	for (const byte of bytes) s += String.fromCharCode(byte)
	return btoa(s)
}

// `Uint8Array<ArrayBuffer>`, not the default `ArrayBufferLike`: WebCrypto's BufferSource
// excludes a SharedArrayBuffer-backed view.
function fromBase64(s: string): Uint8Array<ArrayBuffer> {
	const bin = atob(s)
	const out = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
	return out
}

// WebCrypto only, so the same codec runs in the Worker and on the daemon. The account id
// is the AAD: a ciphertext is bound to the record it was sealed for, so swapping one
// account's `creds` into another's file fails authentication instead of silently binding
// the wrong identity's token.
export function aesGcmSecretCodec(secret: string): SecretCodec {
	let derived: Promise<CryptoKey> | undefined
	const key = () => (derived ??= deriveKey(secret))
	return {
		encode: async (creds, accountId) => {
			if (creds === undefined) return undefined
			const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
			const sealed = new Uint8Array(
				await crypto.subtle.encrypt(
					{ name: 'AES-GCM', iv, additionalData: enc.encode(accountId) },
					await key(),
					enc.encode(JSON.stringify(creds))
				)
			)
			const out = new Uint8Array(iv.length + sealed.length)
			out.set(iv, 0)
			out.set(sealed, iv.length)
			return { v: 1, alg: ALG, ct: toBase64(out) } satisfies Envelope
		},
		decode: async (raw, accountId) => {
			if (!isEnvelope(raw)) return raw
			const bytes = fromBase64(raw.ct)
			const plain = await crypto.subtle.decrypt(
				{
					name: 'AES-GCM',
					iv: bytes.subarray(0, IV_BYTES),
					additionalData: enc.encode(accountId)
				},
				await key(),
				bytes.subarray(IV_BYTES)
			)
			return JSON.parse(dec.decode(plain))
		}
	}
}

// The store's default: clear. It still RECOGNIZES an envelope, so a host with no key (never
// had one, or lost it) reports the record as unreadable rather than handing a provider a
// sealed blob as if it were the credential.
export const clearSecretCodec: SecretCodec = {
	encode: (creds) => creds,
	decode: (raw) => {
		if (isEnvelope(raw)) throw new Error('account credentials are sealed and no key is configured')
		return raw
	}
}
