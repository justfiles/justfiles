import { describe, expect, it } from 'vitest'
import {
	CHARS,
	charToIndex,
	decode,
	encode,
	getPixel,
	indexToChar,
	MAX_COLORS,
	MAX_SIZE,
	newDoc,
	type PixelDoc,
	TRANSPARENT
} from './doc.ts'

describe('base62 char encoding', () => {
	it('maps index 0 to transparent', () => {
		expect(indexToChar(0)).toBe(TRANSPARENT)
		expect(charToIndex(TRANSPARENT)).toBe(0)
	})

	it('maps the boundary indices', () => {
		expect(indexToChar(1)).toBe('0')
		expect(indexToChar(10)).toBe('9')
		expect(indexToChar(11)).toBe('a')
		expect(indexToChar(MAX_COLORS)).toBe('Z')
	})

	it('round-trips every valid index', () => {
		for (let i = 0; i <= MAX_COLORS; i++) expect(charToIndex(indexToChar(i))).toBe(i)
	})

	it('round-trips every base62 char', () => {
		for (const ch of CHARS) expect(indexToChar(charToIndex(ch))).toBe(ch)
	})

	it('collapses out-of-range indices and unknown chars to transparent', () => {
		expect(indexToChar(-1)).toBe(TRANSPARENT)
		expect(indexToChar(MAX_COLORS + 1)).toBe(TRANSPARENT)
		expect(charToIndex('#')).toBe(0)
	})
})

describe('newDoc', () => {
	it('defaults to a blank 32×32 DB16 doc', () => {
		const doc = newDoc()
		expect(doc.width).toBe(32)
		expect(doc.height).toBe(32)
		expect(doc.grid).toHaveLength(32)
		expect(doc.grid.every((row) => row === TRANSPARENT.repeat(32))).toBe(true)
		expect(doc.palette).toHaveLength(16)
	})

	it('honours 16 and 64, clamping to the hard max', () => {
		expect(newDoc(16).width).toBe(16)
		expect(newDoc(64).height).toBe(64)
		expect(newDoc(64).grid).toHaveLength(MAX_SIZE)
	})
})

describe('getPixel', () => {
	const grid = ['.0.', 'a..']
	it('reads the palette index at a cell', () => {
		expect(getPixel(grid, 0, 0)).toBe(0)
		expect(getPixel(grid, 1, 0)).toBe(charToIndex('0'))
		expect(getPixel(grid, 0, 1)).toBe(charToIndex('a'))
	})
	it('reads out-of-bounds as transparent', () => {
		expect(getPixel(grid, -1, 0)).toBe(0)
		expect(getPixel(grid, 3, 0)).toBe(0)
		expect(getPixel(grid, 0, 5)).toBe(0)
	})
})

const bytes = (text: string) => new TextEncoder().encode(text)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe('encode / decode', () => {
	it('round-trips a doc through bytes', () => {
		const doc = newDoc(16)
		doc.grid = doc.grid.map((row, y) => (y === 0 ? `0${row.slice(1)}` : row))
		const back = decode(encode(doc))
		expect(back).toEqual(doc)
	})

	it('emits the section-keyword text format with a char→colour legend', () => {
		const out = text(encode(newDoc(16)))
		expect(out.startsWith('pixel 1\nsize 16 16\npalette\n')).toBe(true)
		// legend maps the exact grid char to its colour — no base62 offset on disk
		expect(out).toContain('\n0 #140c1c\n')
		expect(out).toContain('\nf #deeed6\n')
		expect(out).toContain('\ngrid\n')
		// grid rows are raw ASCII-art (no JSON quoting/commas)
		expect(out).toContain('\n................\n')
	})

	it('parses an LLM-style hand-written grid (size + legend + rows)', () => {
		const doc = decode(
			bytes(
				[
					'pixel 1',
					'size 4 4',
					'palette',
					'6 #d04648',
					'grid',
					'....',
					'.66.',
					'.66.',
					'....'
				].join('\n')
			)
		)
		expect(doc.width).toBe(4)
		expect(doc.height).toBe(4)
		expect(doc.grid).toEqual(['....', '.66.', '.66.', '....'])
		// '6' is the 7th base62 char → palette index 7 → palette[6]
		expect(getPixel(doc.grid, 1, 1)).toBe(charToIndex('6'))
		expect(doc.palette[charToIndex('6') - 1]).toBe('#d04648')
	})

	it('ignores # comments and blank lines, and pads short/tall grids to size', () => {
		const doc = decode(
			bytes(
				[
					'# a heart, drawn by hand',
					'pixel 1',
					'',
					'size 3 3',
					'palette',
					'# just one colour',
					'0 #ffffff',
					'',
					'grid',
					'0', // short row → padded to width 3
					'000'
					// only 2 rows given → padded to height 3
				].join('\n')
			)
		)
		expect(doc.width).toBe(3)
		expect(doc.height).toBe(3)
		expect(doc.grid).toEqual(['0..', '000', '...'])
	})

	it('defaults the palette to DB16 when no legend is given', () => {
		const doc = decode(bytes(['pixel 1', 'grid', '..', '..'].join('\n')))
		expect(doc.width).toBe(2)
		expect(doc.height).toBe(2)
		expect(doc.palette).toHaveLength(16)
	})

	it('clamps size past the hard max', () => {
		const doc = decode(bytes(['pixel 1', 'size 999 999', 'grid'].join('\n')))
		expect(doc.width).toBe(MAX_SIZE)
		expect(doc.height).toBe(MAX_SIZE)
	})

	it('falls back to a fresh doc on garbage or a bad version', () => {
		expect(decode(bytes('not a pixel file'))).toEqual(newDoc())
		expect(decode(bytes('pixel 2\nsize 16 16\ngrid'))).toEqual(newDoc())
		const wrong = { type: 'justfiles/pixel', version: 2 } as unknown as PixelDoc
		expect(decode(encode(wrong))).toEqual(newDoc())
	})
})
