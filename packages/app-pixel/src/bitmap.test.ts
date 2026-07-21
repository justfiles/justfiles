import { describe, expect, it } from 'vitest'
import { clear, drawLine, drawRect, fillRect, floodFill, setPixel } from './bitmap.ts'
import { indexToChar } from './doc.ts'

const blank = (n: number): string[] => Array.from({ length: n }, () => '.'.repeat(n))

// A palette index and its char, so assertions read as the picture.
const A = 1
const a = indexToChar(A) // '0'
const B = 11
const b = indexToChar(B) // 'a'

describe('setPixel', () => {
	it('writes a single cell and leaves the rest untouched', () => {
		expect(setPixel(blank(3), 1, 2, A)).toEqual(['...', '...', `.${a}.`])
	})
	it('ignores out-of-bounds writes', () => {
		const grid = blank(3)
		expect(setPixel(grid, 5, 5, A)).toEqual(grid)
	})
})

describe('drawLine (Bresenham)', () => {
	it('draws a diagonal', () => {
		expect(drawLine(blank(5), 0, 0, 4, 4, A)).toEqual([
			`${a}....`,
			`.${a}...`,
			`..${a}..`,
			`...${a}.`,
			`....${a}`
		])
	})
	it('draws a horizontal run', () => {
		expect(drawLine(blank(3), 0, 1, 2, 1, A)).toEqual(['...', `${a}${a}${a}`, '...'])
	})
})

describe('fillRect', () => {
	it('fills a solid block', () => {
		expect(fillRect(blank(4), 1, 1, 2, 3, A)).toEqual([
			'....',
			`.${a}${a}.`,
			`.${a}${a}.`,
			`.${a}${a}.`
		])
	})
})

describe('drawRect (outline)', () => {
	it('draws only the border', () => {
		expect(drawRect(blank(4), 0, 0, 4, 4, A)).toEqual([
			`${a}${a}${a}${a}`,
			`${a}..${a}`,
			`${a}..${a}`,
			`${a}${a}${a}${a}`
		])
	})
})

describe('floodFill (scanline)', () => {
	it('fills a bounded region without crossing the border', () => {
		const grid = [
			`${a}${a}${a}${a}${a}`,
			`${a}...${a}`,
			`${a}...${a}`,
			`${a}...${a}`,
			`${a}${a}${a}${a}${a}`
		]
		expect(floodFill(grid, 2, 2, B)).toEqual([
			`${a}${a}${a}${a}${a}`,
			`${a}${b}${b}${b}${a}`,
			`${a}${b}${b}${b}${a}`,
			`${a}${b}${b}${b}${a}`,
			`${a}${a}${a}${a}${a}`
		])
	})
	it('is a no-op when the fill matches the target', () => {
		const grid = blank(3)
		expect(floodFill(grid, 0, 0, 0)).toEqual(grid)
	})
})

describe('clear', () => {
	it('resets every cell to transparent', () => {
		expect(clear(fillRect(blank(3), 0, 0, 3, 3, A))).toEqual(blank(3))
	})
})
