import { describe, expect, it } from 'vitest'
import { orderFrames } from './present.tsx'

const frame = (id: string, x: number, y: number, width = 200, height = 100) => ({
	id,
	type: 'frame',
	x,
	y,
	width,
	height
})

describe('orderFrames', () => {
	it('orders slides by reading order, not by scene (z) order', () => {
		// `c` is drawn last but sits top-left, so it presents first.
		const order = orderFrames([frame('b', 400, 0), frame('d', 0, 300), frame('c', 0, 0)])
		expect(order.map((f) => f.id)).toEqual(['c', 'b', 'd'])
	})

	it('treats frames within half a slide-height of each other as one row', () => {
		// `b` sits 40px lower than `a` (tolerance 50) — same row, so x decides.
		const order = orderFrames([frame('b', 400, 40), frame('a', 0, 0), frame('c', 0, 400)])
		expect(order.map((f) => f.id)).toEqual(['a', 'b', 'c'])
	})

	it('ignores non-frames and deleted frames', () => {
		const order = orderFrames([
			{ id: 'rect', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
			{ ...frame('gone', 0, 0), isDeleted: true },
			frame('kept', 0, 200)
		])
		expect(order.map((f) => f.id)).toEqual(['kept'])
	})
})
