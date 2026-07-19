import { memStorage, volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { volumeActiveAi } from './active-ai.ts'

describe('volumeActiveAi', () => {
	test('defaults to null and round-trips a selection', async () => {
		const store = volumeActiveAi(volume(memStorage()))
		expect(await store.get()).toBeNull()

		await store.set({ accountId: 'x', model: 'gpt-x' })
		expect(await store.get()).toEqual({ accountId: 'x', model: 'gpt-x' })

		await store.set({ accountId: 'y' })
		expect(await store.get()).toEqual({ accountId: 'y' })

		await store.set(null)
		expect(await store.get()).toBeNull()
	})
})
