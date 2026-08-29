import { afterEach, expect, test, vi } from 'vitest'
import { imageRenderer } from './image.js'

afterEach(() => vi.unstubAllGlobals())

test('uses an expression face and falls back to the resting image', () => {
	const image = {
		style: {},
		set src(value: string) {
			this.currentSrc = value
		},
		currentSrc: '',
		remove: vi.fn()
	} as unknown as HTMLImageElement
	vi.stubGlobal('document', { createElement: () => image })
	const host = {
		dataset: {},
		replaceChildren: vi.fn()
	} as unknown as HTMLElement
	const handle = imageRenderer.mount(
		host,
		{ id: 'portrait', src: 'resting.png', faces: { pleased: 'pleased.png' } },
		{ expression: 'pleased' }
	)

	expect(host.replaceChildren).toHaveBeenCalledWith(image)
	expect(image.currentSrc).toBe('pleased.png')
	expect(host.dataset.art).toBe('face')

	handle.update({ expression: 'curious' })
	expect(image.currentSrc).toBe('resting.png')
	expect(host.dataset.art).toBe('fallback')

	handle.destroy()
	expect(image.remove).toHaveBeenCalledOnce()
	expect(host.dataset.art).toBeUndefined()
})
