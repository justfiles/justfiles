import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { persistedState } from './persistedState'
import type { Storage } from './storage'
import { nativeStorage } from './storage.fs'
import { memStorage } from './storage.mem'
import { volume } from './volume'

const storage = () => memStorage({ mintIno: () => crypto.randomUUID() })

describe('persistedState', () => {
	test('get() creates the file from init on first access', async () => {
		const vol = volume(storage())
		const state = persistedState<string>(vol, '/.state/id', () => 'minted')
		expect(await state.get()).toBe('minted')
		expect(await vol.exists('/.state/id')).toBe(true)
	})

	test('get() reads back an existing file instead of re-running init', async () => {
		const backing = storage()
		const vol = volume(backing)
		await vol.mkdir('/.state', { recursive: true })
		await vol.writeFile('/.state/id', new TextEncoder().encode(JSON.stringify('existing')))

		const state = persistedState<string>(vol, '/.state/id', () => 'minted')
		expect(await state.get()).toBe('existing')
	})

	test('set() always overwrites, even once a value is cached', async () => {
		const vol = volume(storage())
		const state = persistedState<string>(vol, '/.state/id', () => 'minted')
		await state.get()
		await state.set('replaced')
		expect(await state.get()).toBe('replaced')
		expect(JSON.parse(new TextDecoder().decode(await vol.readFile('/.state/id')))).toBe('replaced')
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
		const vol = volume(backing)
		expect(JSON.parse(new TextDecoder().decode(await vol.readFile('/.state/id')))).toBe(x)
	})

	test('two cells over a BARE memStorage() (no mintIno) still converge', async () => {
		// memStorage() always installs atomicCreate (defaulting the minter to
		// crypto.randomUUID) — a caller-supplied mintIno customizes inode identity,
		// it never gates whether creates are atomic. Every shipped backend (mem,
		// idb, node, sqlite) claims a name atomically; persistedState's guarantee
		// does not have a silent exception for "mem, if you forgot mintIno".
		const backing = memStorage()
		let minted = 0
		const a = persistedState<string>(volume(backing), '/.state/id', () => `id-${++minted}`)
		const b = persistedState<string>(volume(backing), '/.state/id', () => `id-${++minted}`)
		const [x, y] = await Promise.all([a.get(), b.get()])
		expect(x).toBe(y)
	})

	test('a claim loser reads a complete value on the very first attempt, never a poll', async () => {
		// Pins the dependency on write-then-publish (#321/#322): on a backend with a
		// hash-addressed content store, the winner's content is durable BEFORE its
		// name is, so readSettled's retry loop is provably a no-op here, not just
		// usually fast. If this ever needed a real retry, `read` (and therefore
		// `vol.readFile`) would have to be called more than once per loser.
		const backing = storage()
		let reads = 0
		const tracked = {
			...volume(backing),
			readFile: (path: string) => {
				reads++
				return volume(backing).readFile(path)
			}
		}
		let minted = 0
		const a = persistedState<string>(tracked, '/.state/id', () => `id-${++minted}`)
		const b = persistedState<string>(tracked, '/.state/id', () => `id-${++minted}`)
		const [x, y] = await Promise.all([a.get(), b.get()])
		expect(x).toBe(y)
		expect(reads).toBe(1) // exactly the loser's one read — no second attempt
	})

	test('a reader that finds the path via exists() tolerates a native-style create-then-fill gap, even a slow one', async () => {
		// nativeStorage has no hash-addressed content store, so writeFile keeps the OLD
		// create-then-fill order: the dirent (and so exists()) can go true a moment
		// before putBlob lands. A cell whose get() lands in exactly that gap must not
		// crash trying to JSON.parse an empty read -- it must tolerate it exactly like a
		// claim loser does.
		//
		// 200ms is deliberately well past readSettled's OLD bound (a fixed 50 zero-delay
		// attempts, which measured ~55ms on a plain dev machine -- a proxy for wall-clock
		// time, not an actual deadline) and comfortably under its current one (elapsed
		// time, not attempt count) -- pinning that a genuinely slow but eventually-
		// landing write is tolerated, not just a fast one.
		//
		// A SINGLE writer, deliberately -- who wins a create race is a different property
		// (pinned elsewhere); racing two claims here would make this test's own outcome
		// depend on which one wins under load, not on the thing actually under test.
		const dir = mkdtempSync(join(tmpdir(), 'persisted-torn-'))
		try {
			const real = await nativeStorage(dir)
			const slow: Storage = {
				...real,
				async putBlob(ino, data, opts) {
					await new Promise((r) => setTimeout(r, 200))
					return real.putBlob(ino, data, opts)
				}
			}
			const path = '/.state/id'
			await volume(real).mkdir('/.state', { recursive: true })
			const writing = volume(slow).writeFile(
				path,
				new TextEncoder().encode(JSON.stringify('from-a'))
			)
			// createNode is NOT delayed, only putBlob is -- wait for the dirent to actually
			// publish (however long that takes) rather than guessing a fixed delay, so the
			// read below is guaranteed to land in the gap regardless of system load.
			while (!(await volume(real).exists(path))) {
				await new Promise((r) => setTimeout(r, 0))
			}
			const readerResult = await persistedState<string>(volume(real), path, () => 'from-b').get()
			await writing
			expect(readerResult).toBe('from-a')
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test('a permanent read failure (EISDIR) propagates immediately, never waiting out the deadline', async () => {
		// The retry above exists for exactly one signature: an empty read. Anything
		// else -- the path turned out to be a directory, a permission error, real
		// corruption -- is never going to resolve by waiting, so it must not pay
		// readSettled's full deadline before surfacing.
		const vol = volume(storage())
		await vol.mkdir('/.state/id', { recursive: true }) // a DIRECTORY at the cell's own path
		const state = persistedState<string>(vol, '/.state/id', () => 'minted')
		const start = Date.now()
		await expect(state.get()).rejects.toThrow(/^EISDIR/)
		expect(Date.now() - start).toBeLessThan(500) // nowhere near the 2000ms deadline
	})

	test('a rejected first get() is not poisoned: a later get() on the same cell can retry', async () => {
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
