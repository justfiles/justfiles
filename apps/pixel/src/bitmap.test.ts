import { describe, expect, it } from 'vitest'
import {
	clear,
	drawLine,
	drawRect,
	fillRect,
	floodFill,
	gridDiff,
	resizeGrid,
	setPixel,
	setPixels
} from './bitmap.ts'
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

describe('setPixels', () => {
	it('plots a batch and clips out-of-bounds cells', () => {
		expect(
			setPixels(blank(3), [
				{ x: 0, y: 0, i: A },
				{ x: 2, y: 2, i: B },
				{ x: 9, y: 9, i: A }
			])
		).toEqual([`${a}..`, '...', `..${b}`])
	})
	it('writes index 0 as transparent (erase)', () => {
		expect(setPixels(fillRect(blank(2), 0, 0, 2, 2, A), [{ x: 0, y: 0, i: 0 }])).toEqual([
			`.${a}`,
			`${a}${a}`
		])
	})
})

describe('resizeGrid', () => {
	const grid = [`${a}${a}${a}`, `${a}${b}${a}`, `${a}${a}${a}`]
	it('crops to a smaller canvas keeping the top-left', () => {
		expect(resizeGrid(grid, 2, 2)).toEqual([`${a}${a}`, `${a}${b}`])
	})
	it('pads a larger canvas with transparent', () => {
		expect(resizeGrid(grid, 4, 4)).toEqual([
			`${a}${a}${a}.`,
			`${a}${b}${a}.`,
			`${a}${a}${a}.`,
			'....'
		])
	})
})

describe('clear', () => {
	it('resets every cell to transparent', () => {
		expect(clear(fillRect(blank(3), 0, 0, 3, 3, A))).toEqual(blank(3))
	})
})

describe('gridDiff', () => {
	it('reports only changed cells as {x,y,i}', () => {
		const before = blank(3)
		const after = setPixels(before, [
			{ x: 0, y: 0, i: A },
			{ x: 2, y: 1, i: B }
		])
		expect(gridDiff(before, after)).toEqual([
			{ x: 0, y: 0, i: A },
			{ x: 2, y: 1, i: B }
		])
	})
	it('reports an erase as index 0', () => {
		const before = fillRect(blank(2), 0, 0, 2, 2, A)
		const after = setPixels(before, [{ x: 0, y: 0, i: 0 }])
		expect(gridDiff(before, after)).toEqual([{ x: 0, y: 0, i: 0 }])
	})
	it('is empty for identical grids and is its own inverse (undo)', () => {
		const before = blank(4)
		const after = drawLine(before, 0, 0, 3, 3, A)
		expect(gridDiff(before, before)).toEqual([])
		// Replaying the reverse diff through setPixels restores the earlier grid.
		expect(setPixels(after, gridDiff(after, before))).toEqual(before)
	})
})
