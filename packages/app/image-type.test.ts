import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { imageDataUrl, imageType } from './image-type.ts'

// The point of sniffing is that a NAME is a claim and the bytes are a fact — so the checked-in
// art is read here off disk, with its name deliberately ignored.
const ART = new URL('../agent/avatars/vanilla/resting.png', import.meta.url)
const bytes = (...values: number[]) => new Uint8Array(values)
const text = (value: string) => new TextEncoder().encode(value)

test('the real art identifies itself, whatever it is called', () => {
	const png = new Uint8Array(readFileSync(ART))
	expect(imageType(png)).toBe('image/png')
	expect(imageDataUrl(png)?.startsWith('data:image/png;base64,iVBOR')).toBe(true)
})

test.each([
	['png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1), 'image/png'],
	['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0, 1), 'image/jpeg'],
	['gif', text('GIF89a...'), 'image/gif'],
	// RIFF alone is not enough: WAV starts the same way and is not an image.
	['webp', bytes(...text('RIFF'), 0, 0, 0, 0, ...text('WEBP')), 'image/webp'],
	['wav', bytes(...text('RIFF'), 0, 0, 0, 0, ...text('WAVE')), null],
	['bmp', text('BM......'), 'image/bmp'],
	['avif', bytes(0, 0, 0, 0x20, ...text('ftyp'), ...text('avif')), 'image/avif'],
	['heic', bytes(0, 0, 0, 0x20, ...text('ftyp'), ...text('heic')), 'image/heic'],
	['mp4', bytes(0, 0, 0, 0x20, ...text('ftyp'), ...text('isom')), null],
	['svg', text('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'],
	['svg with a prolog', text('<?xml version="1.0"?>\n<svg/>'), 'image/svg+xml'],
	['nothing recognisable', text('hello, this is not art'), null],
	['empty', bytes(), null]
])('%s', (_name, input, expected) => {
	expect(imageType(input)).toBe(expected)
})

test('an unrecognised file gets no URL rather than a lie', () => {
	// A caller then treats that state as one it cannot render — better than an <img> pointed
	// at bytes the browser will refuse.
	expect(imageDataUrl(text('not an image'))).toBeNull()
})
