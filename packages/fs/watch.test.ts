/**
 * Tests for the change-feed `subscribe` cap and the inotify-style
 * `volume.watch` primitive built on top of it.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Storage, StorageChange } from './storage'
import { nativeStorage } from './storage.fs'
import { memStorage } from './storage.mem'
import { chroot, volume } from './volume'

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
	it('fires meta and dirent on a fresh create, then content on a later byte-level update', async () => {
		const storage = memStorage()
		const changes: StorageChange[] = []
		storage.caps?.subscribe?.((c) => changes.push(c))
		const vol = volume(storage)

		await vol.writeFile('/a.txt', enc.encode('hi'))
		const kinds = changes.map((c) => c.kind)
		expect(kinds).toContain('meta') // inode created
		expect(kinds).toContain('dirent') // entry bound in parent
		// No SEPARATE 'content' event here: write-then-publish (docs/write-then-
		// publish.html) makes the bytes durable and claims the name in one atomic
		// step for a fresh create, so there is nothing left to signal separately —
		// the 'meta' event above already carries the final contentHash.
		expect(changes.every((c) => c.source === undefined)).toBe(true)

		const ino = (await vol.stat('/a.txt')).ino
		const dirent = changes.find((c) => c.kind === 'dirent')
		expect(dirent?.name).toBe('a.txt')
		expect(dirent?.ino).toBe(ino)

		// A tagged write to an EXISTING inode still fires its own 'content' event —
		// this is the update path (writeFile's other branch / a direct putBlob),
		// untouched by write-then-publish.
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

	it('binds a path whose parent directory does not exist yet', async () => {
		const vol = volume(memStorage())

		let fired = 0
		await vol.watch('/state/app.json', () => {
			fired++
		})

		// Creating an unrelated dir must not fire (the path still does not resolve).
		await vol.mkdir('/other')
		await flush()
		expect(fired).toBe(0)

		// Creating the missing parent then the file binds the watch and fires.
		await vol.mkdir('/state')
		await vol.writeFile('/state/app.json', enc.encode('1'))
		await flush()
		expect(fired).toBeGreaterThanOrEqual(1)

		// A later content edit fires via the now-bound inode.
		const settled = fired
		await vol.writeFile('/state/app.json', enc.encode('2'))
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

describe('volume.watch recursive', () => {
	it('follows a symlinked root to where the events actually land', async () => {
		const vol = volume(memStorage())
		await vol.mkdir('/notes/trips', { recursive: true })
		await vol.symlink('/notes', '/alias')

		let fired = 0
		// The app's own reads through /alias land on /notes, so its watch must too.
		await vol.watch('/alias', () => fired++, { recursive: true })

		await vol.writeFile('/notes/trips/kyoto.md', enc.encode('go'))
		await flush()
		expect(fired).toBe(1)

		await vol.writeFile('/elsewhere.md', enc.encode('x'))
		await flush()
		expect(fired).toBe(1)
	})

	it('watches a root that does not exist yet', async () => {
		const vol = volume(memStorage())

		let fired = 0
		// What frieren's dock does: watch `/applications` before anything has seeded it.
		// Nothing to resolve through yet, so the root is held as spelled and the creating
		// writes still arrive — otherwise the first boot would watch nothing at all.
		await vol.watch('/applications', () => fired++, { recursive: true })

		await vol.mkdir('/applications')
		await flush()
		// The root's own creation counts: it IS the watched path.
		expect(fired).toBe(1)

		await vol.writeFile('/applications/app.js', enc.encode('x'))
		await flush()
		expect(fired).toBe(2)

		// …and a sibling subtree's churn (an import writing a thousand notes) stays out.
		await vol.mkdir('/notes', { recursive: true })
		await vol.writeFile('/notes/kyoto.md', enc.encode('go'))
		await flush()
		expect(fired).toBe(2)
	})

	it('wakes when an ancestor moves, taking the subtree with it', async () => {
		const vol = volume(memStorage())
		await vol.mkdir('/notes/trips', { recursive: true })
		await vol.writeFile('/notes/trips/kyoto.md', enc.encode('go'))

		let fired = 0
		await vol.watch('/notes/trips', () => fired++, { recursive: true })

		// Renaming an ancestor empties the watched subtree without touching a single
		// path inside it — descendants keep their parent-ino-keyed dirents, so the only
		// event is on the moved entry itself.
		await vol.rename('/notes', '/archive')
		await flush()
		expect(await vol.exists('/notes/trips')).toBe(false)
		expect(fired).toBe(1)

		// A path that merely shares a prefix is not an ancestor.
		await vol.mkdir('/notes-archive/trips', { recursive: true })
		await vol.writeFile('/notes-archive/trips/x.md', enc.encode('x'))
		await flush()
		expect(fired).toBe(1)

		// Moving it back is the same story in reverse: the subtree reappears.
		await vol.rename('/archive', '/notes')
		await flush()
		expect(await vol.exists('/notes/trips')).toBe(true)
		expect(fired).toBe(2)
	})

	it('resolves a non-canonical watch root the way every other operation does', async () => {
		const vol = volume(memStorage())
		await vol.mkdir('/notes/trips', { recursive: true })

		let fired = 0
		// The same subtree, spelled the long way round — `stat`/`scan` resolve this to
		// /notes, so a watch must not silently watch nothing instead.
		await vol.watch('/notes/trips/../', () => fired++, { recursive: true })

		await vol.writeFile('/notes/kyoto.md', enc.encode('go'))
		await flush()
		expect(fired).toBe(1)

		await vol.writeFile('/elsewhere.md', enc.encode('x'))
		await flush()
		expect(fired).toBe(1)
	})

	it('is scoped to the watched subtree', async () => {
		const vol = volume(memStorage())
		await vol.mkdir('/notes/trips', { recursive: true })
		await vol.mkdir('/state', { recursive: true })
		const notes = chroot(vol, '/notes')

		let fired = 0
		// What an app gets: a recursive watch on its own chroot's root.
		await notes.watch('/', () => fired++, { recursive: true })

		// The kernel writing an app's state file is not this app's business.
		await vol.writeFile('/state/app.json', enc.encode('{}'))
		await flush()
		expect(fired).toBe(0)

		// A create inside the subtree — however deep — is.
		await notes.writeFile('/trips/kyoto.md', enc.encode('go'))
		await flush()
		expect(fired).toBe(1)

		// Renaming out of scope still fires (the entry left the listing).
		await vol.rename('/notes/trips/kyoto.md', '/state/kyoto.md')
		await flush()
		expect(fired).toBe(2)

		// A sibling prefix must not be mistaken for the subtree.
		await vol.mkdir('/notesy', { recursive: true })
		await vol.writeFile('/notesy/x.md', enc.encode('x'))
		await flush()
		expect(fired).toBe(2)
	})

	it('fires on a structural change anywhere in the tree, not on content edits', async () => {
		const vol = volume(memStorage())
		await vol.mkdir('/deep/nested', { recursive: true })
		await vol.writeFile('/a.txt', enc.encode('1'))

		let fired = 0
		let lastSource: string | undefined = 'sentinel'
		await vol.watch(
			'/',
			(e) => {
				fired++
				lastSource = e.source
			},
			{ recursive: true }
		)

		// A nested create fires — a single-path watch on '/' never would.
		await vol.writeFile('/deep/nested/b.txt', enc.encode('1'))
		await flush()
		expect(fired).toBe(1)
		expect(lastSource).toBeUndefined()

		// A content edit to an existing file keeps the entry set identical → no fire.
		// (The exact no-op assertion is the heart of "structural changes only".)
		await vol.writeFile('/a.txt', enc.encode('2'))
		await flush()
		expect(fired).toBe(1)

		// Remove and rename reshape the tree → fire (counts coalesce per write).
		await vol.rm('/deep/nested/b.txt')
		await flush()
		expect(fired).toBeGreaterThan(1)

		const settled = fired
		await vol.writeFile('/c.txt', enc.encode('1'))
		await vol.rename('/c.txt', '/d.txt')
		await flush()
		expect(fired).toBeGreaterThan(settled)
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
		// `waitFor`, not `flush()`: the watch listener re-resolves the path before it
		// fires, and on this backend that is real filesystem I/O. A fixed number of timer
		// turns is a proxy for "long enough", not a statement of what is being asserted,
		// which is that the event ARRIVES. The proxy got tighter when a fresh create
		// stopped needing a trailing putBlob (#324), and then stopped holding.
		await vol.writeFile('/note.txt', enc.encode('hello'))
		await waitFor(() => expect(fired).toBeGreaterThanOrEqual(1))

		// rename → atomicMove (emits a dirent rebind on the destination path).
		const settled = fired
		await vol.writeFile('/other.txt', enc.encode('x'))
		await vol.rename('/other.txt', '/note.txt')
		await waitFor(() => expect(fired).toBeGreaterThan(settled))
	})

	it('scopes a recursive watch to the subtree', async () => {
		dir = mkdtempSync(join(tmpdir(), 'fs-watch-'))
		// Spelled with a trailing separator, as a configured root easily is.
		const vol = volume(await nativeStorage(`${dir}/`))
		await vol.mkdir('/notes', { recursive: true })
		await vol.mkdir('/state', { recursive: true })

		let fired = 0
		await chroot(vol, '/notes').watch('/', () => fired++, { recursive: true })

		await vol.writeFile('/state/app.json', enc.encode('{}'))
		await flush()
		expect(fired).toBe(0)

		await vol.writeFile('/notes/kyoto.md', enc.encode('go'))
		await waitFor(() => expect(fired).toBe(1))
	})
})
