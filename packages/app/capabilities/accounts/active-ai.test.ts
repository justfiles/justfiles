import { memStorage, volume } from '@justfiles/fs'
import { PRIVATE_PREFIXES } from '@justfiles/sync/replica'
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

	// The selection names an account in THIS host's credential store, so it has to live in the
	// same never-replicated lane. Synced, it outlives accounts that were never here and lets
	// two hosts overwrite each other's choice — so the lane is pinned, not incidental.
	test('is host-private: written inside a never-replicated prefix', async () => {
		const vol = volume(memStorage())
		await volumeActiveAi(vol).set({ accountId: 'x' })
		const written: string[] = []
		await vol.scan('/', async (path) => {
			if (path.endsWith('active-ai.json')) written.push(path)
		})
		expect(written).toEqual(['/private/active-ai.json'])
		expect(PRIVATE_PREFIXES.some((p) => written[0].startsWith(`${p}/`))).toBe(true)
	})
})
