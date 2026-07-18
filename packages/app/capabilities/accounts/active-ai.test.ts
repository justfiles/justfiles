import { memStorage, volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { volumeActiveAi } from './active-ai.ts'

describe('volumeActiveAi', () => {
	test('defaults to null and round-trips a selection', async () => {
		const store = volumeActiveAi(volume(memStorage()))
		expect(await store.get()).toBeNull()

		await store.set({ connectionId: 'x', model: 'gpt-x' })
		expect(await store.get()).toEqual({ connectionId: 'x', model: 'gpt-x' })

		await store.set({ connectionId: 'y' })
		expect(await store.get()).toEqual({ connectionId: 'y' })

		await store.set(null)
		expect(await store.get()).toBeNull()
	})
})
