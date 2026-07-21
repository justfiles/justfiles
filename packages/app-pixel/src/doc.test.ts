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

describe('encode / decode', () => {
	it('round-trips a doc through bytes', () => {
		const doc = newDoc(16)
		doc.grid = doc.grid.map((row, y) => (y === 0 ? `0${row.slice(1)}` : row))
		const back = decode(encode(doc))
		expect(back).toEqual(doc)
	})

	it('falls back to a fresh doc on garbage or a bad version', () => {
		expect(decode(new TextEncoder().encode('not json'))).toEqual(newDoc())
		const wrong = { type: 'justfiles/pixel', version: 2 } as unknown as PixelDoc
		expect(decode(encode(wrong))).toEqual(newDoc())
	})
})
