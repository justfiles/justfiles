import type { Cell, Grid, Slot } from './types.js'

export function cellKey(row: number, col: number): Cell {
	return `${row},${col}`
}

export function parseCell(key: Cell): { row: number; col: number } {
	const [r, c] = key.split(',')
	return { row: Number(r), col: Number(c) }
}

export function isPlayCell(grid: Grid, row: number, col: number): boolean {
	if (row < 0 || row >= grid.length) return false
	const r = grid[row]
	if (!r || col < 0 || col >= r.length) return false
	return r[col] !== '#'
}

export function solutionAt(grid: Grid, row: number, col: number): string | undefined {
	return grid[row]?.[col]
}

export function totalPlayCells(grid: Grid): number {
	let n = 0
	for (const row of grid) for (const ch of row) if (ch !== '#') n++
	return n
}

export function slotCells(slot: Slot): Cell[] {
	const out: Cell[] = []
	for (let i = 0; i < slot.length; i++) {
		const r = slot.direction === 'down' ? slot.row + i : slot.row
		const c = slot.direction === 'across' ? slot.col + i : slot.col
		out.push(cellKey(r, c))
	}
	return out
}

export function gradeAll(grid: Grid, userGrid: Record<Cell, string>): Cell[] {
	const wrong: Cell[] = []
	for (let r = 0; r < grid.length; r++) {
		const row = grid[r] ?? ''
		for (let c = 0; c < row.length; c++) {
			const sol = row[c]
			if (sol === '#') continue
			if (userGrid[cellKey(r, c)] !== sol) wrong.push(cellKey(r, c))
		}
	}
	return wrong
}

export function gradeCells(grid: Grid, userGrid: Record<Cell, string>, cells: Cell[]): Cell[] {
	const wrong: Cell[] = []
	for (const key of cells) {
		const { row, col } = parseCell(key)
		const sol = solutionAt(grid, row, col)
		if (sol === undefined || sol === '#') continue
		if (userGrid[key] !== sol) wrong.push(key)
	}
	return wrong
}

export function isSolved(grid: Grid, userGrid: Record<Cell, string>): boolean {
	for (let r = 0; r < grid.length; r++) {
		const row = grid[r] ?? ''
		for (let c = 0; c < row.length; c++) {
			const sol = row[c]
			if (sol === '#') continue
			if (userGrid[cellKey(r, c)] !== sol) return false
		}
	}
	return true
}

export function maskGrid(grid: Grid): Grid {
	return grid.map((row) =>
		row
			.split('')
			.map((ch) => (ch === '#' ? '#' : '.'))
			.join('')
	)
}
