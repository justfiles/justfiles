import { expect, test } from 'bun:test'
import { slots } from './slots.js'

test('empty grid emits no slots', () => {
	const grid = ['.....', '.....', '.....']
	expect(slots(grid)).toEqual([])
})

test('single across word becomes one fully-known slot', () => {
	const grid = ['#####', '#CAT#', '#####']
	const result = slots(grid)
	expect(result).toEqual([
		{ id: 'A1', direction: 'across', row: 1, col: 1, length: 3, pattern: 'CAT' }
	])
})

test('single down word becomes one fully-known slot', () => {
	const grid = ['##C##', '##A##', '##T##']
	const result = slots(grid)
	expect(result).toEqual([
		{ id: 'D1', direction: 'down', row: 0, col: 2, length: 3, pattern: 'CAT' }
	])
})

test('crossing words emit two slots — one across one down', () => {
	const grid = ['#######', '##A####', '##B####', '#CABLE#', '##T####', '##E####', '#######']
	const result = slots(grid)
	expect(result).toEqual([
		{ id: 'A1', direction: 'across', row: 3, col: 1, length: 5, pattern: 'CABLE' },
		{ id: 'D1', direction: 'down', row: 1, col: 2, length: 5, pattern: 'ABATE' }
	])
})

test('partially filled slot has ? where empty', () => {
	const grid = ['#####', '#C.T#', '#####']
	const result = slots(grid)
	expect(result).toEqual([
		{ id: 'A1', direction: 'across', row: 1, col: 1, length: 3, pattern: 'C?T' }
	])
})

test('runs of length 1 are not slots', () => {
	const grid = ['#A#', '#B#', '#C#']
	const result = slots(grid)
	// A,B,C across runs are length 1 each → skipped
	// down run at col 1 is length 3 → kept
	expect(result).toEqual([
		{ id: 'D1', direction: 'down', row: 0, col: 1, length: 3, pattern: 'ABC' }
	])
})

test('runs containing no letters at all are skipped', () => {
	// fully empty bounded region → not anchored, skip
	const grid = ['#####', '#...#', '#####']
	expect(slots(grid)).toEqual([])
})

test('numbering is sequential per direction in row-major scan order', () => {
	const grid = ['#CAT#', '#####', '#DOG#']
	const result = slots(grid)
	expect(result.map((s) => s.id)).toEqual(['A1', 'A2'])
})
