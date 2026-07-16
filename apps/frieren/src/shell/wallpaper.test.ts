import { describe, expect, test } from 'vitest'
import { imageType } from './wallpaper'

function bytes(...values: (number | string)[]): Uint8Array {
	const out: number[] = []
	for (const v of values)
		if (typeof v === 'string') out.push(...new TextEncoder().encode(v))
		else out.push(v)
	return new Uint8Array(out)
}

describe('imageType', () => {
	test('png', () => {
		expect(imageType(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png')
	})
	test('jpeg', () => {
		expect(imageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
	})
	test('gif', () => {
		expect(imageType(bytes('GIF89a'))).toBe('image/gif')
	})
	test('webp', () => {
		expect(imageType(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe('image/webp')
	})
	test('avif (ISO BMFF ftyp)', () => {
		expect(imageType(bytes(0, 0, 0, 0x1c, 'ftypavif'))).toBe('image/avif')
	})
	test('svg', () => {
		expect(imageType(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml')
	})
	test('unknown bytes fall back to png', () => {
		expect(imageType(bytes(1, 2, 3, 4))).toBe('image/png')
	})
})
