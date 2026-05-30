/**
 * Tests for the change-feed `subscribe` cap and the inotify-style
 * `volume.watch` primitive built on top of it (Phase 2b).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Storage, StorageChange } from './storage'
import { nativeStorage } from './storage.fs'
import { memStorage } from './storage.mem'
import { volume } from './volume'

const enc = new TextEncoder()
// Drain the microtask queue (watch coalesces deliveries onto a microtask).
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function waitFor(assertion: () => void): Promise<void> {
	const deadline = Date.now() + 100
	let lastError: unknown
	while (Date.now() < deadline) {
		try {
			assertion()
			return
		} catch (e) {
			lastError = e
			await flush()
		}
	}
	throw lastError
}

describe('storage subscribe cap', () => {
	it('fires meta, content and dirent changes with their source', async () => {
		const storage = memStorage()
		const changes: StorageChange[] = []
		storage.caps?.subscribe?.((c) => changes.push(c))
		const vol = volume(storage)

		await vol.writeFile('/a.txt', enc.encode('hi'))
		const kinds = changes.map((c) => c.kind)
		expect(kinds).toContain('meta') // inode created
		expect(kinds).toContain('dirent') // entry bound in parent
		expect(kinds).toContain('content') // bytes written
		expect(changes.every((c) => c.source === undefined)).toBe(true)

		const ino = (await vol.stat('/a.txt')).ino
		const dirent = changes.find((c) => c.kind === 'dirent')
		expect(dirent?.name).toBe('a.txt')
		expect(dirent?.ino).toBe(ino)

		// A tagged write carries its source through the feed.
		changes.length = 0
		await storage.putBlob(ino, enc.encode('bye'), { source: 'remote' })
		expect(changes).toEqual([{ ino, kind: 'content', source: 'remote' }])
	})

	it('is inert (no listeners) and unsubscribe stops delivery', async () => {
		const storage = memStorage()
		const vol = volume(storage)
		await vol.writeFile('/a.txt', enc.encode('1'))

		const seen: StorageChange[] = []
		const off = storage.caps?.subscribe?.((c) => seen.push(c))
		await vol.writeFile('/a.txt', enc.encode('2'))
		expect(seen.length).toBeGreaterThan(0)
		off?.()
		const after = seen.length
		await vol.writeFile('/a.txt', enc.encode('3'))
		expect(seen.length).toBe(after)
	})
})

describe('volume.watch', () => {
	it('fires on content and meta change of the watched path', async () => {
		const vol = volume(memStorage())
		await vol.writeFile('/s.json', enc.encode('1'))

		let fired = 0
		let lastSource: string | undefined = 'sentinel'
		const off = await vol.watch('/s.json', (e) => {
			fired++
			lastSource = e.source
		})

		await vol.writeFile('/s.json', enc.encode('2'))
		await flush()
		expect(fired).toBe(1)
		expect(lastSource).toBeUndefined()

		await vol.chmod('/s.json', 0o600)
		await flush()
		expect(fired).toBe(2)

		off()
		await vol.writeFile('/s.json', enc.encode('3'))
		await flush()
		expect(fired).toBe(2)
	})

	it('passes the write source through (so callers ignore their own writes)', async () => {
		const storage = memStorage()
		const vol = volume(storage)
		await vol.writeFile('/s.json', enc.encode('1'))
		const ino = (await vol.stat('/s.json')).ino

		let lastSource: string | undefined
		await vol.watch('/s.json', (e) => {
			lastSource = e.source
		})

		await storage.putBlob(ino, enc.encode('agent'), { source: 'remote' })
		await flush()
		expect(lastSource).toBe('remote')
	})

	it('coalesces the several ops of one logical write into one event', async () => {
		const storage = memStorage()
		const vol = volume(storage)
		await vol.writeFile('/s.json', enc.encode('1'))
		const ino = (await vol.stat('/s.json')).ino

		let fired = 0
		await vol.watch('/s.json', () => {
			fired++
		})

		// Two storage mutations in the same synchronous turn → one delivery.
		void storage.setMeta(ino, { mode: 0o600 })
		void storage.putBlob(ino, enc.encode('22'))
		await flush()
		expect(fired).toBe(1)
	})

	it('re-resolves when the path is rebound (delete + recreate)', async () => {
		const vol = volume(memStorage())
		await vol.writeFile('/r.json', enc.encode('1'))

		let fired = 0
		await vol.watch('/r.json', () => {
			fired++
		})

		await vol.rm('/r.json')
		await flush()
		const afterDelete = fired
		expect(afterDelete).toBeGreaterThanOrEqual(1)

		await vol.writeFile('/r.json', enc.encode('2'))
		await flush()
		expect(fired).toBeGreaterThan(afterDelete)

		// A plain content edit on the *new* inode must still fire — proves the
		// watch re-resolved the path to the fresh inode.
		const settled = fired
		await vol.writeFile('/r.json', enc.encode('3'))
		await flush()
		expect(fired).toBe(settled + 1)
	})

	it('re-resolves on rename/replace of the watched path', async () => {
		const vol = volume(memStorage())
		await vol.writeFile('/dest.json', enc.encode('old'))
		await vol.writeFile('/src.json', enc.encode('new'))

		let fired = 0
		await vol.watch('/dest.json', () => {
			fired++
		})

		await vol.rename('/src.json', '/dest.json')
		await flush()
		expect(fired).toBeGreaterThanOrEqual(1)

		// Editing the content that now backs /dest.json fires via the rebound ino.
		const settled = fired
		await vol.writeFile('/dest.json', enc.encode('newer'))
		await flush()
		expect(fired).toBe(settled + 1)
	})

	it('returns a no-op when the storage has no change feed', async () => {
		const base = memStorage()
		const noFeed: Storage = { ...base, caps: { ...base.caps, subscribe: undefined } }
		const vol = volume(noFeed)
		await vol.writeFile('/s.json', enc.encode('1'))

		let fired = 0
		const off = await vol.watch('/s.json', () => {
			fired++
		})
		await vol.writeFile('/s.json', enc.encode('2'))
		await flush()
		expect(fired).toBe(0)
		expect(() => off()).not.toThrow()
	})
})

describe('volume.watch over the atomic-cap backend (nativeStorage)', () => {
	let dir: string
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true })
	})

	it('fires on atomicCreate and atomicMove', async () => {
		dir = mkdtempSync(join(tmpdir(), 'fs-watch-'))
		const vol = volume(await nativeStorage(dir))

		let fired = 0
		await vol.watch('/note.txt', () => {
			fired++
		})

		// createNode → atomicCreate (emits meta + dirent for the new path).
		await vol.writeFile('/note.txt', enc.encode('hello'))
		await flush()
		expect(fired).toBeGreaterThanOrEqual(1)

		// rename → atomicMove (emits a dirent rebind on the destination path).
		const settled = fired
		await vol.writeFile('/other.txt', enc.encode('x'))
		await vol.rename('/other.txt', '/note.txt')
		await waitFor(() => expect(fired).toBeGreaterThan(settled))
	})
})
