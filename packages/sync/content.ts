export async function hashBytes(data: Uint8Array): Promise<string> {
	const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function verifyBytes(hash: string, data: Uint8Array): Promise<Uint8Array> {
	if ((await hashBytes(data)) !== hash) throw new Error(`content hash mismatch: ${hash}`)
	return data
}
