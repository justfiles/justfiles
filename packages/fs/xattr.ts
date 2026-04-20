const enc = new TextEncoder()
const dec = new TextDecoder()

export const XATTR_NAMESPACE = 'ghostore.'

export const GHOSTORE_XATTR = {
	title: `${XATTR_NAMESPACE}title`,
	tags: `${XATTR_NAMESPACE}tags`,
	links: `${XATTR_NAMESPACE}links`,
	source: `${XATTR_NAMESPACE}source`
} as const

export function encodeXattr(value: unknown): Uint8Array {
	return enc.encode(JSON.stringify(value))
}

export function decodeXattr<T>(buf: Uint8Array): T {
	return JSON.parse(dec.decode(buf)) as T
}
