const encoder = new TextEncoder()

export function toBase64Url(bytes: Uint8Array): string {
	let value = ''
	for (const byte of bytes) value += String.fromCharCode(byte)
	return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
	const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
	const bytes = new Uint8Array(decoded.length)
	for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i)
	return bytes
}

export const randomSecret = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(32)))

export async function hashSecret(value: string): Promise<string> {
	return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
}
