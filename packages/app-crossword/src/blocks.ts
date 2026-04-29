import type { Grid, Placement } from './types.js'

export function addBlocks(grid: Grid, placements: Placement[]): Grid {
	const rows = grid.map((r) => r.split(''))
	const height = rows.length
	const width = rows[0]?.length ?? 0

	// Count placements per cell. A cell with >1 owner is a crossing point and
	// must stay reachable from both directions — don't bound it perpendicularly.
	const owners = new Map<string, number>()
	for (const p of placements) {
		for (let i = 0; i < p.answer.length; i++) {
			const r = p.direction === 'across' ? p.row : p.row + i
			const c = p.direction === 'across' ? p.col + i : p.col
			const key = `${r},${c}`
			owners.set(key, (owners.get(key) ?? 0) + 1)
		}
	}
	const isCrossed = (r: number, c: number): boolean => (owners.get(`${r},${c}`) ?? 0) > 1

	for (const p of placements) {
		// 1. Bound the word ends (so the across/down word doesn't extend).
		const beforeR = p.direction === 'across' ? p.row : p.row - 1
		const beforeC = p.direction === 'across' ? p.col - 1 : p.col
		const endR = p.direction === 'across' ? p.row : p.row + p.answer.length - 1
		const endC = p.direction === 'across' ? p.col + p.answer.length - 1 : p.col
		const afterR = p.direction === 'across' ? p.row : endR + 1
		const afterC = p.direction === 'across' ? endC + 1 : p.col
		setBlock(rows, beforeR, beforeC, height, width)
		setBlock(rows, afterR, afterC, height, width)

		// 2. For each non-crossed letter, bound the perpendicular axis so it
		//    isn't the lone anchor of an unbounded 11-cell slot.
		for (let i = 0; i < p.answer.length; i++) {
			const r = p.direction === 'across' ? p.row : p.row + i
			const c = p.direction === 'across' ? p.col + i : p.col
			if (isCrossed(r, c)) continue
			if (p.direction === 'across') {
				setBlock(rows, r - 1, c, height, width)
				setBlock(rows, r + 1, c, height, width)
			} else {
				setBlock(rows, r, c - 1, height, width)
				setBlock(rows, r, c + 1, height, width)
			}
		}
	}

	return rows.map((r) => r.join(''))
}

function setBlock(rows: string[][], r: number, c: number, h: number, w: number): void {
	if (r < 0 || c < 0 || r >= h || c >= w) return
	const row = rows[r]
	if (row && row[c] === '.') row[c] = '#'
}
