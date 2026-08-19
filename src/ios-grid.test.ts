import { describe, expect, it } from 'vitest'
import {
	IOS_GRID_CENTER,
	IOS_GRID_INNER_INSET,
	IOS_GRID_OFFSETS,
	IOS_GRID_OUTER_INSET,
	IOS_GRID_RADII,
	IOS_GRID_SIZE,
	IOS_GRID_SQUIRCLE_PATH
} from './ios-grid.ts'

const [small, middle, large] = IOS_GRID_RADII

describe('Apple’s app icon grid', () => {
	it('rules symmetric lines about the centre', () => {
		const mirrored = IOS_GRID_OFFSETS.map((offset) => IOS_GRID_SIZE - offset).reverse()

		for (const [index, offset] of IOS_GRID_OFFSETS.entries()) {
			expect(offset).toBeCloseTo(mirrored[index]!, 10)
		}
	})

	it('divides each quadrant by the golden ratio Apple documents', () => {
		expect(IOS_GRID_CENTER / IOS_GRID_INNER_INSET).toBeCloseTo(1.6, 10)
	})

	it('inscribes the small circle in the inner square and the large one in the outer square', () => {
		expect(IOS_GRID_CENTER - small).toBe(IOS_GRID_INNER_INSET)
		expect(IOS_GRID_CENTER - large).toBeCloseTo(IOS_GRID_OUTER_INSET, 10)
	})

	it('runs the middle circle through the inner square’s corners, a root-two step', () => {
		const corner = IOS_GRID_CENTER - IOS_GRID_INNER_INSET
		expect(Math.hypot(corner, corner)).toBeCloseTo(middle, 10)
		expect(middle / small).toBeCloseTo(Math.SQRT2, 10)
	})

	it('draws a squircle that exactly fills the 1024 canvas', () => {
		const coords = IOS_GRID_SQUIRCLE_PATH.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []

		expect(coords.length).toBeGreaterThan(100)
		expect(Math.min(...coords)).toBeCloseTo(0, 1)
		expect(Math.max(...coords)).toBeCloseTo(IOS_GRID_SIZE, 1)
	})
})
