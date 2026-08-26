export type Direction = 'across' | 'down'
export type Cell = `${number},${number}`
export type Placement = { answer: string; direction: Direction; row: number; col: number }
export type Slot = {
	id: string
	direction: Direction
	row: number
	col: number
	length: number
	pattern: string
}

export const cellKey = (r: number, c: number): Cell => `${r},${c}`

// Place seeds into a sizeXsize grid, longest first. First seed lands centered;
// each subsequent seed must cross an existing letter. Letters that don't fit
// are returned in `unplaced`. Empty cells are '.'.
export function place(
	seeds: string[],
	size: number
): { grid: string[][]; placements: Placement[]; unplaced: string[] } {
	const grid: string[][] = Array.from({ length: size }, () => Array(size).fill('.'))
	const placements: Placement[] = []
	const unplaced: string[] = []

	for (const seed of [...seeds].sort((a, b) => b.length - a.length)) {
		if (seed.length > size) {
			unplaced.push(seed)
			continue
		}
		const p =
			placements.length === 0
				? ({
						answer: seed,
						direction: 'across',
						row: Math.floor(size / 2),
						col: Math.floor((size - seed.length) / 2)
					} as Placement)
				: findCrossing(seed, placements, grid, size)
		if (!p) {
			unplaced.push(seed)
			continue
		}
		write(grid, p)
		placements.push(p)
	}
	return { grid, placements, unplaced }
}

function findCrossing(
	seed: string,
	placements: Placement[],
	grid: string[][],
	size: number
): Placement | null {
	for (let i = 0; i < seed.length; i++) {
		for (const e of placements) {
			for (let j = 0; j < e.answer.length; j++) {
				if (e.answer[j] !== seed[i]) continue
				const direction: Direction = e.direction === 'across' ? 'down' : 'across'
				const cr = e.direction === 'across' ? e.row : e.row + j
				const cc = e.direction === 'across' ? e.col + j : e.col
				const candidate: Placement = {
					answer: seed,
					direction,
					row: direction === 'across' ? cr : cr - i,
					col: direction === 'across' ? cc - i : cc
				}
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
		const cell = grid[r]?.[c] ?? '.'
		if (cell !== '.' && cell !== answer[i]) return false
		if (cell === '.') {
			if (direction === 'across') {
				if (r > 0 && (grid[r - 1]?.[c] ?? '.') !== '.') return false
				if (r < size - 1 && (grid[r + 1]?.[c] ?? '.') !== '.') return false
			} else {
				if (c > 0 && (grid[r]?.[c - 1] ?? '.') !== '.') return false
				if (c < size - 1 && (grid[r]?.[c + 1] ?? '.') !== '.') return false
			}
		}
	}
	const beforeR = direction === 'across' ? row : row - 1
	const beforeC = direction === 'across' ? col - 1 : col
	if (
		beforeR >= 0 &&
		beforeC >= 0 &&
		beforeR < size &&
		beforeC < size &&
		(grid[beforeR]?.[beforeC] ?? '.') !== '.'
	)
		return false
	const afterR = direction === 'across' ? row : endRow + 1
	const afterC = direction === 'across' ? endCol + 1 : col
	if (
		afterR >= 0 &&
		afterC >= 0 &&
		afterR < size &&
		afterC < size &&
		(grid[afterR]?.[afterC] ?? '.') !== '.'
	)
		return false
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

// Block out cells that would create unbounded slots: word ends, and the
// perpendicular sides of every non-crossing letter.
export function addBlocks(grid: string[][], placements: Placement[]): string[][] {
	const rows = grid.map((r) => [...r])
	const h = rows.length
	const w = rows[0]?.length ?? 0
	const owners = new Map<string, number>()
	for (const p of placements) {
		for (let i = 0; i < p.answer.length; i++) {
			const r = p.direction === 'across' ? p.row : p.row + i
			const c = p.direction === 'across' ? p.col + i : p.col
			const k = `${r},${c}`
			owners.set(k, (owners.get(k) ?? 0) + 1)
		}
	}
	const block = (r: number, c: number) => {
		if (r < 0 || c < 0 || r >= h || c >= w) return
		const row = rows[r]
		if (row && row[c] === '.') row[c] = '#'
	}
	for (const p of placements) {
		const endR = p.direction === 'across' ? p.row : p.row + p.answer.length - 1
		const endC = p.direction === 'across' ? p.col + p.answer.length - 1 : p.col
		block(
			p.direction === 'across' ? p.row : p.row - 1,
			p.direction === 'across' ? p.col - 1 : p.col
		)
		block(p.direction === 'across' ? p.row : endR + 1, p.direction === 'across' ? endC + 1 : p.col)
		for (let i = 0; i < p.answer.length; i++) {
			const r = p.direction === 'across' ? p.row : p.row + i
			const c = p.direction === 'across' ? p.col + i : p.col
			if ((owners.get(`${r},${c}`) ?? 0) > 1) continue
			if (p.direction === 'across') {
				block(r - 1, c)
				block(r + 1, c)
			} else {
				block(r, c - 1)
				block(r, c + 1)
			}
		}
	}
	return rows
}

// Detect runs of length ≥ 2 across rows and down columns. '?' represents an
// unfilled cell; '#' is a block.
export function findSlots(grid: string[][]): Slot[] {
	const h = grid.length
	const w = grid[0]?.length ?? 0
	const out: Slot[] = []
	let an = 0
	for (let r = 0; r < h; r++) {
		const row = grid[r] ?? []
		let c = 0
		while (c < w) {
			if (row[c] === '#') {
				c++
				continue
			}
			let end = c
			while (end < w && row[end] !== '#') end++
			const seg = row.slice(c, end)
			if (end - c >= 2 && seg.some((ch) => ch >= 'A' && ch <= 'Z')) {
				out.push({
					id: `A${++an}`,
					direction: 'across',
					row: r,
					col: c,
					length: end - c,
					pattern: seg.map((ch) => (ch === '.' ? '?' : ch)).join('')
				})
			}
			c = end
		}
	}
	let dn = 0
	for (let c = 0; c < w; c++) {
		let r = 0
		while (r < h) {
			if ((grid[r]?.[c] ?? '#') === '#') {
				r++
				continue
			}
			let end = r
			while (end < h && (grid[end]?.[c] ?? '#') !== '#') end++
			const seg: string[] = []
			for (let k = r; k < end; k++) seg.push(grid[k]?.[c] ?? '.')
			if (end - r >= 2 && seg.some((ch) => ch >= 'A' && ch <= 'Z')) {
				out.push({
					id: `D${++dn}`,
					direction: 'down',
					row: r,
					col: c,
					length: end - r,
					pattern: seg.map((ch) => (ch === '.' ? '?' : ch)).join('')
				})
			}
			r = end
		}
	}
	return out
}

// Build the puzzle grid from seed words. After placement and blocking, any
// still-empty cell isn't part of any answered slot — block it out so the
// returned grid contains only blocks and letters.
export function buildPuzzle(
	seeds: string[],
	size: number
): { grid: string[] /* row strings */; slots: Slot[]; unplaced: string[] } {
	const { grid: placed, placements, unplaced } = place(seeds, size)
	const blocked = addBlocks(placed, placements)
	const slots = findSlots(blocked)
	for (const row of blocked) for (let c = 0; c < row.length; c++) if (row[c] === '.') row[c] = '#'
	return { grid: blocked.map((r) => r.join('')), slots, unplaced }
}

export function bakeAnswers(
	grid: string[],
	slots: Slot[],
	entries: { slotId: string; answer: string }[]
): string[] {
	const rows = grid.map((r) => r.split(''))
	const slotMap = new Map(slots.map((s) => [s.id, s]))
	for (const e of entries) {
		const s = slotMap.get(e.slotId)
		if (!s) continue
		for (let i = 0; i < e.answer.length; i++) {
			const r = s.direction === 'across' ? s.row : s.row + i
			const c = s.direction === 'across' ? s.col + i : s.col
			const row = rows[r]
			if (row && e.answer[i]) row[c] = e.answer[i] ?? '#'
		}
	}
	return rows.map((r) => r.join(''))
}

export function patternMatches(answer: string, pattern: string): boolean {
	if (answer.length !== pattern.length) return false
	for (let i = 0; i < pattern.length; i++) {
		const p = pattern[i]
		if (p !== '?' && p !== answer[i]) return false
	}
	return true
}
