import { afterEach, expect, it, vi } from 'vitest'
import { persistStorage } from './store.idb'

const withStorage = (storage: unknown) =>
	vi.stubGlobal('navigator', { storage } as unknown as Navigator)

afterEach(() => vi.unstubAllGlobals())

it('does not ask again once the origin is already persistent', async () => {
	// The one that matters: Firefox prompts on `persist()`, so asking when the
	// answer is already yes would re-prompt on every load.
	const persist = vi.fn()
	withStorage({ persisted: async () => true, persist })

	expect(await persistStorage()).toBe(true)
	expect(persist).not.toHaveBeenCalled()
})

it('asks when it is not persistent yet, and reports the answer', async () => {
	withStorage({ persisted: async () => false, persist: async () => true })
	expect(await persistStorage()).toBe(true)

	withStorage({ persisted: async () => false, persist: async () => false })
	expect(await persistStorage()).toBe(false)
})

it('keeps asking after a refusal, because engagement heuristics change', async () => {
	// Chrome and Safari decide silently from engagement, so a first visit is
	// usually refused and a later one may not be. Nothing here remembers a no.
	const persist = vi.fn(async () => false)
	withStorage({ persisted: async () => false, persist })

	await persistStorage()
	await persistStorage()
	expect(persist).toHaveBeenCalledTimes(2)
})

it('reports false where the API is missing or throws', async () => {
	withStorage(undefined)
	expect(await persistStorage()).toBe(false)

	vi.stubGlobal('navigator', undefined)
	expect(await persistStorage()).toBe(false)

	withStorage({
		persisted: async () => {
			throw new Error('denied')
		},
		persist: async () => true
	})
	expect(await persistStorage()).toBe(false)
})
