import { describe, expect, it, vi } from 'vitest'
import { afterPaint, errorMessage } from '../entrypoints/popup/main.ts'

describe('popup errors', () => {
	it('paints the loading shell before starting auth', async () => {
		const frames: FrameRequestCallback[] = []
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			frames.push(callback)
			return frames.length
		})
		const load = vi.fn().mockResolvedValue('ready')

		const result = afterPaint(load)
		expect(load).not.toHaveBeenCalled()
		frames.shift()?.(0)
		await Promise.resolve()
		expect(load).not.toHaveBeenCalled()
		frames.shift()?.(16)
		expect(await result).toBe('ready')
		expect(load).toHaveBeenCalledOnce()
	})

	it('keeps the missing-app remediation actionable', () => {
		expect(errorMessage('app_not_installed')).toBe(
			'Open Just Computer once to finish setting up Read, then retry.'
		)
	})

	it.each([
		'invalid_request',
		'invalid_params',
		'action_not_found',
		'action_failed'
	])('maps %s to a short message', (code) => {
		expect(errorMessage(code)).toBeTruthy()
		expect(errorMessage(code)).not.toContain(code)
	})
})
