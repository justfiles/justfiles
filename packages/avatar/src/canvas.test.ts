import { afterEach, expect, test, vi } from 'vitest'
import { avatar } from './canvas.js'
import { gameboyAvatar } from './gameboy.js'

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
	const testAvatar = avatar({ id: 'test', width: 20, height: 10, draw })
	const host = { dataset: {}, replaceChildren: vi.fn() } as unknown as HTMLElement
	const handle = testAvatar.mount(host)

	expect(draw).toHaveBeenCalledOnce()
	expect(requestAnimationFrame).not.toHaveBeenCalled()
	expect(host.dataset).toEqual({ avatar: 'test', expression: 'resting' })

	now.mockReturnValue(200)
	handle.update({ expression: 'pleased' })
	expect(draw).toHaveBeenCalledTimes(2)
	expect(draw.mock.calls[1]?.[1]).toMatchObject({ expression: 'pleased', reducedMotion: true })
	expect(host.dataset.expression).toBe('pleased')

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
	expect(host.dataset).toEqual({})
})

test('renders a still RGBA image', () => {
	const draw = vi.fn((context: CanvasRenderingContext2D) => {
		context.fillStyle = '#ff0000'
		context.fillRect(0, 0, 1, 1)
	})
	const testAvatar = avatar({ id: 'dot', width: 2, height: 1, draw })

	const image = testAvatar.render({ expression: 'pleased' })

	expect(image).toEqual({
		width: 2,
		height: 1,
		data: new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0])
	})
	expect(draw.mock.calls[0]?.[1]).toEqual({
		time: 0,
		expression: 'pleased',
		previousExpression: 'pleased',
		expressionChangedAt: 0,
		reducedMotion: true
	})
})

test('renders the Game Boy avatar without browser globals', () => {
	const image = gameboyAvatar.render()

	expect(image.width).toBe(256)
	expect(image.height).toBe(256)
	expect(image.data[3]).toBe(0)
	expect(image.data.some((alpha, index) => index % 4 === 3 && alpha === 255)).toBe(true)
})
