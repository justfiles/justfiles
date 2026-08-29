import { afterEach, expect, test, vi } from 'vitest'
import { type CanvasSkin, canvasRenderer } from './canvas.js'

afterEach(() => vi.unstubAllGlobals())

test('repaints reduced-motion avatars without an animation loop', () => {
	const context = {} as CanvasRenderingContext2D
	const canvas = {
		style: {},
		setAttribute: vi.fn(),
		getContext: vi.fn(() => context),
		remove: vi.fn()
	} as unknown as HTMLCanvasElement
	const listeners = new Set<() => void>()
	const motion = {
		matches: true,
		addEventListener: vi.fn((_type: string, listener: () => void) => listeners.add(listener)),
		removeEventListener: vi.fn((_type: string, listener: () => void) => listeners.delete(listener))
	}
	const requestAnimationFrame = vi.fn(() => 7)
	const cancelAnimationFrame = vi.fn()
	const now = vi.fn(() => 100)

	vi.stubGlobal('document', {
		hidden: false,
		createElement: vi.fn(() => canvas),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn()
	})
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => motion)
	)
	vi.stubGlobal('requestAnimationFrame', requestAnimationFrame)
	vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
	vi.stubGlobal('performance', { now })

	const draw = vi.fn()
	const skin: CanvasSkin = { id: 'test', width: 20, height: 10, draw }
	const host = { replaceChildren: vi.fn() } as unknown as HTMLElement
	const handle = canvasRenderer.mount(host, skin, { expression: null })

	expect(draw).toHaveBeenCalledOnce()
	expect(requestAnimationFrame).not.toHaveBeenCalled()

	now.mockReturnValue(200)
	handle.update({ expression: 'pleased' })
	expect(draw).toHaveBeenCalledTimes(2)
	expect(draw.mock.calls[1]?.[1]).toMatchObject({ expression: 'pleased', reducedMotion: true })

	motion.matches = false
	for (const listener of listeners) listener()
	expect(draw).toHaveBeenCalledTimes(3)
	expect(requestAnimationFrame).toHaveBeenCalledOnce()

	motion.matches = true
	for (const listener of listeners) listener()
	expect(draw).toHaveBeenCalledTimes(4)
	expect(requestAnimationFrame).toHaveBeenCalledOnce()
	expect(cancelAnimationFrame).toHaveBeenLastCalledWith(7)

	handle.destroy()
	expect(motion.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
})
