import type { Direction, Grid, Placement } from './types.js'

export function place(
	seeds: string[],
	size: number
): { grid: Grid; placements: Placement[]; unplaced: string[] } {
	const grid: string[][] = Array.from({ length: size }, () => Array(size).fill('.'))
	const placements: Placement[] = []
	const unplaced: string[] = []

	const queue = [...seeds].sort((a, b) => b.length - a.length)

	for (const seed of queue) {
		if (seed.length > size) {
			unplaced.push(seed)
			continue
		}
		const placement =
			placements.length === 0 ? placeFirst(seed, size) : placeCrossing(seed, placements, grid, size)
		if (!placement) {
			unplaced.push(seed)
			continue
		}
		write(grid, placement)
		placements.push(placement)
	}

	return { grid: grid.map((r) => r.join('')), placements, unplaced }
}

function placeFirst(seed: string, size: number): Placement {
	const row = Math.floor(size / 2)
	const col = Math.floor((size - seed.length) / 2)
	return { answer: seed, direction: 'across', row, col }
}

function placeCrossing(
	seed: string,
	placements: Placement[],
	grid: string[][],
	size: number
): Placement | null {
	for (let i = 0; i < seed.length; i++) {
		const letter = seed[i]
		for (const existing of placements) {
			for (let j = 0; j < existing.answer.length; j++) {
				if (existing.answer[j] !== letter) continue
				const direction: Direction = existing.direction === 'across' ? 'down' : 'across'
				const crossRow = existing.direction === 'across' ? existing.row : existing.row + j
				const crossCol = existing.direction === 'across' ? existing.col + j : existing.col
				const row = direction === 'across' ? crossRow : crossRow - i
				const col = direction === 'across' ? crossCol - i : crossCol
				const candidate: Placement = { answer: seed, direction, row, col }
				if (fits(candidate, grid, size)) return candidate
			}
		}
	}
	return null
}

function fits(p: Placement, grid: string[][], size: number): boolean {
	const { answer, direction, row, col } = p
	if (row < 0 || col < 0) return false
	const endRow = direction === 'across' ? row : row + answer.length - 1
	const endCol = direction === 'across' ? col + answer.length - 1 : col
	if (endRow >= size || endCol >= size) return false

	for (let i = 0; i < answer.length; i++) {
		const r = direction === 'across' ? row : row + i
		const c = direction === 'across' ? col + i : col
		const cell = cellAt(grid, r, c)
		if (cell !== '.' && cell !== answer[i]) return false
		if (cell === '.') {
			if (direction === 'across') {
				if (r > 0 && cellAt(grid, r - 1, c) !== '.') return false
				if (r < size - 1 && cellAt(grid, r + 1, c) !== '.') return false
			} else {
				if (c > 0 && cellAt(grid, r, c - 1) !== '.') return false
				if (c < size - 1 && cellAt(grid, r, c + 1) !== '.') return false
			}
		}
	}

	const beforeR = direction === 'across' ? row : row - 1
	const beforeC = direction === 'across' ? col - 1 : col
	if (inBounds(beforeR, beforeC, size) && cellAt(grid, beforeR, beforeC) !== '.') return false
	const afterR = direction === 'across' ? row : endRow + 1
	const afterC = direction === 'across' ? endCol + 1 : col
	if (inBounds(afterR, afterC, size) && cellAt(grid, afterR, afterC) !== '.') return false

	return true
}

function write(grid: string[][], p: Placement): void {
	for (let i = 0; i < p.answer.length; i++) {
		const r = p.direction === 'across' ? p.row : p.row + i
		const c = p.direction === 'across' ? p.col + i : p.col
		const row = grid[r]
		if (row) row[c] = p.answer[i] ?? '.'
	}
}

function cellAt(grid: string[][], r: number, c: number): string {
	return grid[r]?.[c] ?? '.'
}

function inBounds(r: number, c: number, size: number): boolean {
	return r >= 0 && c >= 0 && r < size && c < size
}
