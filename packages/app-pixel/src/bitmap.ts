// Pure grid primitives over the char-row grid. Each is `(grid, …, i) => grid`:
// it converts the immutable `string[]` rows to a mutable char matrix once, plots,
// and joins back once. `i` is a palette index (0 = transparent); chars are an
// internal encoding detail owned by doc.ts.
import { indexToChar, TRANSPARENT } from './doc.ts'

type Grid = string[]

const toCells = (grid: Grid): string[][] => grid.map((row) => [...row])
const fromCells = (cells: string[][]): Grid => cells.map((row) => row.join(''))

function plot(cells: string[][], x: number, y: number, ch: string): void {
	const row = cells[y]
	if (row && x >= 0 && x < row.length) row[x] = ch
}

// Bresenham line, plotted into the mutable matrix.
function line(cells: string[][], x0: number, y0: number, x1: number, y1: number, ch: string): void {
	let ax = Math.round(x0)
	let ay = Math.round(y0)
	const bx = Math.round(x1)
	const by = Math.round(y1)
	const dx = Math.abs(bx - ax)
	const dy = -Math.abs(by - ay)
	const sx = ax < bx ? 1 : -1
	const sy = ay < by ? 1 : -1
	let err = dx + dy
	for (;;) {
		plot(cells, ax, ay, ch)
		if (ax === bx && ay === by) break
		const e2 = 2 * err
		if (e2 >= dy) {
			err += dy
			ax += sx
		}
		if (e2 <= dx) {
			err += dx
			ay += sy
		}
	}
}

export function setPixel(grid: Grid, x: number, y: number, i: number): Grid {
	const cells = toCells(grid)
	plot(cells, x, y, indexToChar(i))
	return fromCells(cells)
}

// Batch plot — the agent's workhorse and the target of a committed freehand
// stroke: many pixels land in one pass (and one dispatch).
export function setPixels(grid: Grid, pixels: { x: number; y: number; i: number }[]): Grid {
	const cells = toCells(grid)
	for (const { x, y, i } of pixels) plot(cells, x, y, indexToChar(i))
	return fromCells(cells)
}

export function drawLine(
	grid: Grid,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	i: number
): Grid {
	const cells = toCells(grid)
	line(cells, x0, y0, x1, y1, indexToChar(i))
	return fromCells(cells)
}

export function fillRect(grid: Grid, x: number, y: number, w: number, h: number, i: number): Grid {
	const cells = toCells(grid)
	const ch = indexToChar(i)
	for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) plot(cells, xx, yy, ch)
	return fromCells(cells)
}

export function drawRect(grid: Grid, x: number, y: number, w: number, h: number, i: number): Grid {
	const cells = toCells(grid)
	const ch = indexToChar(i)
	const x1 = x + w - 1
	const y1 = y + h - 1
	line(cells, x, y, x1, y, ch)
	line(cells, x, y1, x1, y1, ch)
	line(cells, x, y, x, y1, ch)
	line(cells, x1, y, x1, y1, ch)
	return fromCells(cells)
}

// Scanline flood fill (mirrors app-paint's), comparing chars in-place.
export function floodFill(grid: Grid, x: number, y: number, i: number): Grid {
	const cells = toCells(grid)
	const h = cells.length
	const w = cells[0]?.length ?? 0
	if (x < 0 || y < 0 || x >= w || y >= h) return grid
	const target = cells[y]?.[x]
	const repl = indexToChar(i)
	if (target === undefined || target === repl) return grid
	const stack: number[] = [x, y]
	while (stack.length > 0) {
		const py0 = stack.pop() as number
		const px = stack.pop() as number
		let py = py0
		while (py >= 0 && cells[py]?.[px] === target) py--
		py++
		let spanLeft = false
		let spanRight = false
		while (py < h && cells[py]?.[px] === target) {
			;(cells[py] as string[])[px] = repl
			if (px > 0) {
				const leftSame = cells[py]?.[px - 1] === target
				if (!spanLeft && leftSame) {
					stack.push(px - 1, py)
					spanLeft = true
				} else if (spanLeft && !leftSame) {
					spanLeft = false
				}
			}
			if (px < w - 1) {
				const rightSame = cells[py]?.[px + 1] === target
				if (!spanRight && rightSame) {
					stack.push(px + 1, py)
					spanRight = true
				} else if (spanRight && !rightSame) {
					spanRight = false
				}
			}
			py++
		}
	}
	return fromCells(cells)
}

export function clear(grid: Grid): Grid {
	const w = grid[0]?.length ?? 0
	return grid.map(() => TRANSPARENT.repeat(w))
}

// Re-shape the grid to `w`×`h`, keeping the overlapping top-left region and
// padding the rest transparent. Destructive: pixels outside the new bounds are
// cropped away.
export function resizeGrid(grid: Grid, w: number, h: number): Grid {
	return Array.from({ length: h }, (_, y) => (grid[y] ?? '').slice(0, w).padEnd(w, TRANSPARENT))
}
