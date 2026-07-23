import { afterEach, describe, expect, test, vi } from 'vitest'
import { createServerPoke } from './frieren.poke'

describe('server sync poke', () => {
	afterEach(() => vi.useRealTimers())

	test('sends one second after the latest server write', async () => {
		vi.useFakeTimers()
		const send = vi.fn()
		const poke = createServerPoke(send)

		poke()
		await vi.advanceTimersByTimeAsync(500)
		poke()
		await vi.advanceTimersByTimeAsync(999)
		expect(send).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1)
		expect(send).toHaveBeenCalledOnce()
	})

	test('sends after five seconds of continuous server writes', async () => {
		vi.useFakeTimers()
		const send = vi.fn()
		const poke = createServerPoke(send)

		poke()
		for (let n = 1; n <= 9; n++) {
			await vi.advanceTimersByTimeAsync(500)
			poke()
		}
		await vi.advanceTimersByTimeAsync(499)
		expect(send).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1)
		expect(send).toHaveBeenCalledOnce()
	})
})
