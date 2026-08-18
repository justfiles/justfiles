import { describe, expect, it } from 'vitest'
import { ICON_FIT_FILL_RATIO, iconFitViewportFactor, resizeIconViewport } from './icon-viewport.ts'

describe('icon viewport resize', () => {
	it('fits artwork with equal insets inside the output window', () => {
		expect(iconFitViewportFactor(0.82)).toBeCloseTo(0.7052)
		expect((1 - ICON_FIT_FILL_RATIO) / 2).toBeCloseTo(0.07)
	})

	it('keeps the user’s Excalidraw zoom unchanged', () => {
		for (const viewportSize of [1000, 850, 700, 500, 350]) {
			const resized = resizeIconViewport({
				width: viewportSize,
				height: viewportSize,
				hostLeft: 0,
				hostTop: 0,
				offsetLeft: 0,
				offsetTop: 0,
				scrollX: 0,
				scrollY: 0,
				zoom: 0.8
			})

			expect(resized.zoom).toBe(0.8)
			expect(resized.camera.size).toBe(resized.layout.size / 0.8)
		}
	})
})
