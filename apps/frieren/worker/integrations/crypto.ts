const IV_BYTES = 12

async function deriveKey(material: string): Promise<CryptoKey> {
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
	return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encrypt(plain: string, keyMaterial: string): Promise<Uint8Array> {
	const key = await deriveKey(keyMaterial)
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
	const cipher = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain))
	)
	const out = new Uint8Array(iv.length + cipher.length)
	out.set(iv, 0)
	out.set(cipher, iv.length)
	return out
}

export async function decrypt(payload: Uint8Array, keyMaterial: string): Promise<string> {
	if (payload.length <= IV_BYTES) throw new Error('ciphertext too short')
	const key = await deriveKey(keyMaterial)
	const iv = payload.slice(0, IV_BYTES)
	const cipher = payload.slice(IV_BYTES)
	const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher)
	return new TextDecoder().decode(plain)
}
