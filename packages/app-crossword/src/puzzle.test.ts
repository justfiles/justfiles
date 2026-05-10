import { expect, test } from 'bun:test'
import { addBlocks, buildPuzzle, findSlots, place } from './puzzle.ts'

test('place: single seed centered horizontally', () => {
	const { placements, unplaced } = place(['CAT'], 5)
	expect(unplaced).toEqual([])
	expect(placements).toEqual([{ answer: 'CAT', direction: 'across', row: 2, col: 1 }])
})

test('place: two seeds sharing a letter cross perpendicularly', () => {
	const { placements, unplaced } = place(['CABLE', 'ABATE'], 7)
	expect(unplaced).toEqual([])
	expect(placements).toHaveLength(2)
	const a = placements.find((p) => p.answer === 'CABLE')
	const b = placements.find((p) => p.answer === 'ABATE')
	expect(a?.direction).not.toBe(b?.direction)
})

test('place: seed without shared letter is unplaced', () => {
	const { placements, unplaced } = place(['CAT', 'DOG'], 7)
	expect(placements.map((p) => p.answer)).toEqual(['CAT'])
	expect(unplaced).toEqual(['DOG'])
})

test('place: seed too long is unplaced', () => {
	const { placements, unplaced } = place(['ELEPHANT'], 5)
	expect(placements).toEqual([])
	expect(unplaced).toEqual(['ELEPHANT'])
})

test('addBlocks: bounds word ends and non-crossed perpendicular sides', () => {
	const grid = [
		['.', '.', '.', '.', '.'],
		['.', 'C', 'A', 'T', '.'],
		['.', '.', '.', '.', '.']
	]
	const out = addBlocks(grid, [{ answer: 'CAT', direction: 'across', row: 1, col: 1 }])
	expect(out.map((r) => r.join(''))).toEqual(['.###.', '#CAT#', '.###.'])
})

test('addBlocks: crossing letter is not perpendicularly bounded', () => {
	const grid = [
		['.', 'A', '.', '.', '.'],
		['.', 'B', '.', '.', '.'],
		['C', 'A', 'B', 'L', 'E'],
		['.', 'T', '.', '.', '.'],
		['.', 'E', '.', '.', '.']
	]
	const out = addBlocks(grid, [
		{ answer: 'CABLE', direction: 'across', row: 2, col: 0 },
		{ answer: 'ABATE', direction: 'down', row: 0, col: 1 }
	])
	expect(out.map((r) => r.join(''))).toEqual(['#A#..', '#B###', 'CABLE', '#T###', '#E#..'])
})

test('findSlots: across and down with crossings', () => {
	const grid = '#######|##A####|##B####|#CABLE#|##T####|##E####|#######'
		.split('|')
		.map((r) => r.split(''))
	expect(findSlots(grid)).toEqual([
		{ id: 'A1', direction: 'across', row: 3, col: 1, length: 5, pattern: 'CABLE' },
		{ id: 'D1', direction: 'down', row: 1, col: 2, length: 5, pattern: 'ABATE' }
	])
})

test('findSlots: partially filled slot uses ? for empty cells', () => {
	const grid = '#####|#C.T#|#####'.split('|').map((r) => r.split(''))
	expect(findSlots(grid)).toEqual([
		{ id: 'A1', direction: 'across', row: 1, col: 1, length: 3, pattern: 'C?T' }
	])
})

test('buildPuzzle: empty cells are blocked, slots are detected', () => {
	const { grid, slots, unplaced } = buildPuzzle(['CABLE', 'ABATE'], 7)
	expect(unplaced).toEqual([])
	expect(slots.length).toBeGreaterThan(0)
	for (const row of grid)
		for (const ch of row) expect(ch === '#' || (ch >= 'A' && ch <= 'Z')).toBe(true)
})
