import { expect, test } from 'bun:test'
import { place } from './placement.js'
import type { Placement } from './types.js'

const empty = (size: number): string[] => Array(size).fill('.'.repeat(size))

test('no seeds returns empty grid', () => {
	const { grid, placements, unplaced } = place([], 5)
	expect(grid).toEqual(empty(5))
	expect(placements).toEqual([])
	expect(unplaced).toEqual([])
})

test('single seed placed horizontally centered', () => {
	const { grid, placements, unplaced } = place(['CAT'], 5)
	expect(grid).toEqual(['.....', '.....', '.CAT.', '.....', '.....'])
	expect(placements).toEqual([{ answer: 'CAT', direction: 'across', row: 2, col: 1 }])
	expect(unplaced).toEqual([])
})

test('two seeds sharing a letter cross perpendicularly', () => {
	const { grid, placements, unplaced } = place(['CABLE', 'ABATE'], 7)
	expect(unplaced).toEqual([])
	expect(placements).toHaveLength(2)
	const cable = placements.find((p: Placement) => p.answer === 'CABLE')
	const abate = placements.find((p: Placement) => p.answer === 'ABATE')
	expect(cable).toBeDefined()
	expect(abate).toBeDefined()
	expect(cable?.direction).not.toBe(abate?.direction)
	const rows = grid
	const cols: string[] = []
	for (let c = 0; c < (grid[0]?.length ?? 0); c++) {
		cols.push(grid.map((r) => r[c] ?? '').join(''))
	}
	expect(rows.some((r) => r.includes('CABLE'))).toBe(true)
	expect(cols.some((c) => c.includes('ABATE'))).toBe(true)
})

test('seed with no shared letters becomes unplaced', () => {
	const { placements, unplaced } = place(['CAT', 'DOG'], 7)
	expect(placements.map((p: Placement) => p.answer)).toEqual(['CAT'])
	expect(unplaced).toEqual(['DOG'])
})

test('grid dimensions match requested size', () => {
	const { grid } = place(['HELLO'], 5)
	expect(grid.length).toBe(5)
	for (const row of grid) expect(row.length).toBe(5)
})

test('seed too long for grid is unplaced', () => {
	const { placements, unplaced } = place(['ELEPHANT'], 5)
	expect(placements).toEqual([])
	expect(unplaced).toEqual(['ELEPHANT'])
})
