import type { Direction, Grid, Slot } from './types.js'

export function slots(grid: Grid): Slot[] {
	const height = grid.length
	const width = grid[0]?.length ?? 0
	const out: Slot[] = []

	let acrossN = 0
	for (let r = 0; r < height; r++) {
		const row = grid[r] ?? ''
		let c = 0
		while (c < width) {
			if (row[c] === '#') {
				c++
				continue
			}
			let end = c
			while (end < width && row[end] !== '#') end++
			const length = end - c
			const segment = row.slice(c, end)
			if (length >= 2 && hasLetter(segment)) {
				acrossN++
				out.push({
					id: `A${acrossN}`,
					direction: 'across',
					row: r,
					col: c,
					length,
					pattern: toPattern(segment)
				})
			}
			c = end
		}
	}

	let downN = 0
	for (let c = 0; c < width; c++) {
		const column = readColumn(grid, c, height)
		let r = 0
		while (r < height) {
			if (column[r] === '#') {
				r++
				continue
			}
			let end = r
			while (end < height && column[end] !== '#') end++
			const length = end - r
			const segment = column.slice(r, end)
			if (length >= 2 && hasLetter(segment)) {
				downN++
				out.push({
					id: `D${downN}`,
					direction: 'down' as Direction,
					row: r,
					col: c,
					length,
					pattern: toPattern(segment)
				})
			}
			r = end
		}
	}

	return out
}

function readColumn(grid: Grid, c: number, height: number): string {
	let s = ''
	for (let r = 0; r < height; r++) s += grid[r]?.[c] ?? '.'
	return s
}

function hasLetter(s: string): boolean {
	for (const ch of s) if (ch >= 'A' && ch <= 'Z') return true
	return false
}

function toPattern(s: string): string {
	let out = ''
	for (const ch of s) out += ch === '.' ? '?' : ch
	return out
}
