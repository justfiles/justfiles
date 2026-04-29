import { expect, test } from 'bun:test'
import { addBlocks } from './blocks.js'
import type { Placement } from './types.js'

test('no placements leaves grid untouched', () => {
	const grid = ['.....', '.....', '.....']
	expect(addBlocks(grid, [])).toEqual(grid)
})

test('horizontal placement bounds word ends and perpendicular sides', () => {
	const grid = ['.....', '.CAT.', '.....']
	const placements: Placement[] = [{ answer: 'CAT', direction: 'across', row: 1, col: 1 }]
	expect(addBlocks(grid, placements)).toEqual(['.###.', '#CAT#', '.###.'])
})

test('vertical placement bounds word ends and perpendicular sides', () => {
	const grid = ['..C..', '..A..', '..T..']
	const placements: Placement[] = [{ answer: 'CAT', direction: 'down', row: 0, col: 2 }]
	// word ends out of bounds; perpendicular bounds added on every letter
	expect(addBlocks(grid, placements)).toEqual(['.#C#.', '.#A#.', '.#T#.'])
})

test('placement at grid edge omits out-of-bounds block', () => {
	const grid = ['CAT..', '.....']
	const placements: Placement[] = [{ answer: 'CAT', direction: 'across', row: 0, col: 0 }]
	// row -1 OOB; row 1 perpendicular bounds added
	expect(addBlocks(grid, placements)).toEqual(['CAT#.', '###..'])
})

test('crossing letter is not perpendicularly bounded; non-crossed letters are', () => {
	// CABLE across at row 2, col 0; ABATE down at col 1, rows 0-4.
	// They cross at (2, 1) — that cell stays free.
	const grid = ['.A...', '.B...', 'CABLE', '.T...', '.E...']
	const placements: Placement[] = [
		{ answer: 'CABLE', direction: 'across', row: 2, col: 0 },
		{ answer: 'ABATE', direction: 'down', row: 0, col: 1 }
	]
	const result = addBlocks(grid, placements)
	expect(result).toEqual(['#A#..', '#B###', 'CABLE', '#T###', '#E#..'])
})
