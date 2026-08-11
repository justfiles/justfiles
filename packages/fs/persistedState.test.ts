/**
 * `persistedState`'s first touch is a CLAIM, and that is the whole point of these
 * tests. Two cells over the SAME storage can initialize at the same moment
 * mints `/.state/clientid` through this primitive while `deviceId()` reads that same
 * path through it too — and they must converge on ONE value. `exists()` then `set()`
 * would be a TOCTOU where both see nothing and both write.
 *
 * The loser reads the winner back in a SINGLE read: `writeFile`'s create commits bytes
 * and name as one atomic fact (#324), so the path never exists holding anything but a
 * complete value. That is pinned below by counting reads, not assumed — if it ever
 * stopped holding, the honest fix is at the writer, not a retry loop here.
 */

import { describe, expect, test } from 'vitest'
import { persistedState } from './persistedState'
import { memStorage } from './storage.mem'
import { volume } from './volume'

const storage = () => memStorage({ mintIno: () => crypto.randomUUID() })
const readRaw = async (vol: ReturnType<typeof volume>, path: string) =>
	JSON.parse(new TextDecoder().decode(await vol.readFile(path)))

describe('persistedState', () => {
	test('get() creates the file from init on first access', async () => {
		const vol = volume(storage())
		const state = persistedState<string>(vol, '/.state/id', () => 'minted')
		expect(await state.get()).toBe('minted')
		expect(await vol.exists('/.state/id')).toBe(true)
	})

	test('get() reads back an existing file instead of re-running init', async () => {
		const vol = volume(storage())
		await vol.mkdir('/.state', { recursive: true })
		await vol.writeFile('/.state/id', new TextEncoder().encode(JSON.stringify('existing')))
		const state = persistedState<string>(vol, '/.state/id', () => 'minted')
		expect(await state.get()).toBe('existing')
	})

	test('set() always overwrites, even once a value is cached', async () => {
		// A deliberate update by whoever already owns the value is NOT a first touch, so
		// it stays a plain write with nothing to claim.
		const vol = volume(storage())
		const state = persistedState<string>(vol, '/.state/id', () => 'minted')
		await state.get()
		await state.set('replaced')
		expect(await state.get()).toBe('replaced')
		expect(await readRaw(vol, '/.state/id')).toBe('replaced')
	})

	test('patch() merges a partial update without losing other fields', async () => {
		const vol = volume(storage())
		const state = persistedState(vol, '/.state/cfg', { a: 1, b: 2 })
		await state.patch({ b: 3 })
		expect(await state.get()).toEqual({ a: 1, b: 3 })
	})

	test('two cells over the same storage racing to initialize converge on one value', async () => {
		const backing = storage()
		let minted = 0
		const a = persistedState<string>(volume(backing), '/.state/id', () => `id-${++minted}`)
		const b = persistedState<string>(volume(backing), '/.state/id', () => `id-${++minted}`)
		const [x, y] = await Promise.all([a.get(), b.get()])
		expect(x).toBe(y)
		// Exactly one write survives — the loser's candidate is never persisted.
		expect(await readRaw(volume(backing), '/.state/id')).toBe(x)
	})

	test('two cells over a BARE memStorage() converge too', async () => {
		// `mintIno` customises inode IDENTITY, never whether creates are atomic. While
		// `memStorage()` gated `atomicCreate` on it, this claim silently degraded to
		// volume.ts's non-atomic pre-check on the default in-memory backend — the one
		// `dev-server.ts` runs on — and both cells could believe they won.
		const backing = memStorage()
		let minted = 0
		const a = persistedState<string>(volume(backing), '/.state/id', () => `id-${++minted}`)
		const b = persistedState<string>(volume(backing), '/.state/id', () => `id-${++minted}`)
		const [x, y] = await Promise.all([a.get(), b.get()])
		expect(x).toBe(y)
	})

	test('the loser reads a complete value on its FIRST read, never a poll', async () => {
		// The dependency on write-then-publish (#324), pinned rather than trusted: the
		// winner's bytes are durable before its name is, so one read is provably enough.
		// If this ever needed a second, `readFile` would be called more than once.
		const backing = storage()
		const real = volume(backing)
		let reads = 0
		const counted = {
			...real,
			readFile: (path: string) => {
				reads++
				return real.readFile(path)
			}
		}
		let minted = 0
		const a = persistedState<string>(counted, '/.state/id', () => `id-${++minted}`)
		const b = persistedState<string>(counted, '/.state/id', () => `id-${++minted}`)
		const [x, y] = await Promise.all([a.get(), b.get()])
		expect(x).toBe(y)
		expect(reads).toBe(1) // exactly the loser's one read
	})

	test('a rejected first get() is not poisoned: a later get() can retry', async () => {
		const real = volume(storage())
		let calls = 0
		const flaky = {
			...real,
			exists: (path: string) => {
				calls++
				return calls === 1 ? Promise.reject(new Error('boom')) : real.exists(path)
			}
		}
		const state = persistedState<string>(flaky, '/.state/id', () => 'minted')
		await expect(state.get()).rejects.toThrow('boom')
		expect(await state.get()).toBe('minted')
	})
})
