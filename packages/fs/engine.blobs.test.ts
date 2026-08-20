/**
 * Content, which moves separately from rows. Three claims are on trial here:
 *
 * - **Rule 10, on the push.** The bytes are durable at the peer BEFORE the row
 *   that names them commits. A crash between the two leaves an orphan blob; the
 *   other order leaves a committed row whose content nobody has (proof 2 of 4).
 * - **Dedup by hash.** `has` before `put`, so a rename, a copy, and a re-push of
 *   a row the peer already backs transfer zero bytes.
 * - **Selective content, on the pull.** Rows always land. Whether the bytes
 *   follow is this replica's own choice: eager fetches them behind the page,
 *   lazy fetches nothing and `hydratingBlobs` gets them when a read asks.
 */

import { describe, expect, it } from 'vitest'
import { type CursorSlot, hydratingBlobs, sync, versions } from './engine'
import { memStore } from './mem'
import { type Cursor, type Hash, ROOT, type Store, sha256Hex } from './store'
import type { Volume } from './volume'
import { volume } from './volume'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** The host-local cursor slot. A variable is the whole contract (see T8). */
function slot(): CursorSlot & { at: () => Cursor | undefined } {
	let at: Cursor | undefined
	return {
		load: async () => at,
		save: async (cursor) => {
			at = cursor
		},
		at: () => at
	}
}

/** Two replicas, the slots between them, and a POSIX view over each. */
function pair() {
	const local = memStore()
	const remote = memStore()
	const pull = slot()
	const push = slot()
	return {
		local,
		remote,
		pull,
		push,
		opts: { replica: 'a', pull, push },
		here: volume(local, { mintVersion: versions('a') }),
		there: volume(remote, { mintVersion: versions('b') })
	}
}

/**
 * Every seam call that carries content, in the order it happened — `put` logged
 * once it RESOLVED, `commit` when it was asked for. That is what makes the log
 * an ordering proof and not just a call count.
 */
function trace(store: Store): { store: Store; log: string[] } {
	const log: string[] = []
	return {
		log,
		store: {
			...store,
			commit(writes, guards) {
				log.push('commit')
				return store.commit(writes, guards)
			},
			blobs: {
				has: async (hash) => {
					log.push(`has ${hash}`)
					return store.blobs.has(hash)
				},
				get: async (hash) => {
					log.push(`get ${hash}`)
					return store.blobs.get(hash)
				},
				put: async (hash, data) => {
					await store.blobs.put(hash, data)
					log.push(`put ${hash}`)
				}
			}
		}
	}
}

/** A peer that hands back bytes other than the ones asked for (rule 7). */
const liar = (store: Store): Store => ({
	...store,
	blobs: { ...store.blobs, get: async () => enc.encode('not the bytes you asked for') }
})

const read = async (vol: Volume, path: string): Promise<string> =>
	dec.decode(await vol.readFile(path))

const hashOf = (text: string): Promise<Hash> => sha256Hex(enc.encode(text))

describe('sync: content on the push', () => {
	it('makes the bytes durable at the peer before the row that names them', async () => {
		const { local, remote, here, opts } = pair()
		await here.writeFile('/notes.txt', enc.encode('hello'))
		const hash = await hashOf('hello')
		const peer = trace(remote)

		await sync(local, peer.store, opts)

		// Rule 10, as an order: asked, absent, transferred, and only then the row.
		expect(peer.log).toEqual([`has ${hash}`, `put ${hash}`, 'commit'])
		expect(await read(volume(remote), '/notes.txt')).toBe('hello')
	})

	it('transfers nothing for a hash the peer already holds — a rename is free', async () => {
		const { local, remote, here, opts } = pair()
		await here.writeFile('/notes.txt', enc.encode('hello'))
		await sync(local, remote, opts)

		await here.rename('/notes.txt', '/renamed.txt')
		const peer = trace(remote)
		await sync(local, peer.store, opts)

		expect(peer.log.filter((call) => call.startsWith('put'))).toEqual([])
		expect(await read(volume(remote), '/renamed.txt')).toBe('hello')
	})

	it('transfers nothing for a tombstone, whose content hash is dead weight', async () => {
		const { local, remote, here, opts } = pair()
		await here.writeFile('/gone.txt', enc.encode('hello'))
		await here.rm('/gone.txt')
		const peer = trace(remote)

		await sync(local, peer.store, opts)

		expect(peer.log).toEqual(['commit'])
		expect(await remote.child(ROOT, 'gone.txt')).toBeNull()
	})

	it('leaves an orphan blob when the commit dies, never a row whose bytes are lost', async () => {
		// Proof 2 of 4. The crash lands in the one window rule 10 creates: the peer
		// holds the bytes and does not yet hold the row.
		const { local, remote, here, push, opts } = pair()
		await here.writeFile('/notes.txt', enc.encode('hello'))
		const hash = await hashOf('hello')
		const dying: Store = { ...remote, commit: () => Promise.reject(new Error('crash')) }

		await expect(sync(local, dying, { ...opts, retries: 0 })).rejects.toThrow('crash')

		expect(await remote.blobs.has(hash)).toBe(true)
		expect(await remote.child(ROOT, 'notes.txt')).toBeNull()
		expect(push.at()).toBeUndefined()

		// The re-run costs the re-scan and nothing more: the bytes are already there.
		const peer = trace(remote)
		await sync(local, peer.store, opts)

		expect(peer.log.filter((call) => call.startsWith('put'))).toEqual([])
		expect(await read(volume(remote), '/notes.txt')).toBe('hello')
	})

	it('offers a page of hashes side by side, not one after another', async () => {
		const { local, remote, here, opts } = pair()
		for (let n = 0; n < 20; n++) await here.writeFile(`/n${n}.txt`, enc.encode(`file ${n}`))
		let live = 0
		let peak = 0
		const peer: Store = {
			...remote,
			blobs: {
				...remote.blobs,
				async has(hash) {
					live++
					peak = Math.max(peak, live)
					// A turn of the loop, or a memStore answers inside the same microtask and
					// every ask looks alone.
					await new Promise((resolve) => setTimeout(resolve, 0))
					try {
						return await remote.blobs.has(hash)
					} finally {
						live--
					}
				}
			}
		}

		await sync(local, peer, opts)

		// Every hash is up to three round trips at the peer, and no two of them are
		// about the same bytes — content is keyed by hash. Rule 10 is untouched: all of
		// them are durable there before the commit that names any of them.
		expect(peak).toBeGreaterThan(1)
		expect(await read(volume(remote), '/n19.txt')).toBe('file 19')
	})
})

describe('sync: content on the pull', () => {
	it('fetches the bytes behind the rows it applied', async () => {
		const { local, remote, there, opts } = pair()
		await there.writeFile('/notes.txt', enc.encode('hello'))

		await sync(local, remote, opts)

		expect(await read(volume(local), '/notes.txt')).toBe('hello')
	})

	it('fetches only what it does not already hold', async () => {
		const { local, remote, here, there, opts } = pair()
		// The same bytes on both sides under different names: the hash is the same,
		// so the row travels and the content does not.
		await here.writeFile('/mine.txt', enc.encode('hello'))
		await there.writeFile('/theirs.txt', enc.encode('hello'))
		const peer = trace(remote)

		await sync(local, peer.store, opts)

		expect(peer.log.filter((call) => call.startsWith('get'))).toEqual([])
		expect(await read(volume(local), '/theirs.txt')).toBe('hello')
	})

	it('refuses bytes that do not hash to the key, and keeps the row as a stub', async () => {
		const { local, remote, there, opts } = pair()
		await there.writeFile('/notes.txt', enc.encode('hello'))
		const hash = await hashOf('hello')

		await expect(sync(local, liar(remote), { ...opts, retries: 0 })).rejects.toThrow(/do not hash/)

		// Rule 7: a peer's bytes are checked before they land. The row still did —
		// its bytes live at the peer, and a stub is a materialization gap, not loss.
		expect(await local.blobs.has(hash)).toBe(false)
		expect(await local.child(ROOT, 'notes.txt')).toMatchObject({ content: hash })
	})

	it('takes a row whose bytes the peer cannot produce, and reads it when the peer can', async () => {
		const { local, remote, there, opts } = pair()
		await there.writeFile('/notes.txt', enc.encode('hello'))
		const hash = await hashOf('hello')
		// A peer holding the row and not the bytes: itself a lazy replica, or a blob
		// still on its way. The rows have to converge regardless, so a fetch that finds
		// nothing is skipped rather than fatal — one unfetchable blob must not stop
		// every later page.
		const stub: Store = {
			...remote,
			blobs: { ...remote.blobs, has: async () => false, get: async () => null }
		}

		await sync(local, stub, opts)

		expect(await local.child(ROOT, 'notes.txt')).toMatchObject({ content: hash })
		expect(await local.blobs.has(hash)).toBe(false)

		// And no later cycle comes back to that hash: a blob write takes no feed
		// position, so the peer hydrating it produces no row for a scan to find.
		await sync(local, remote, opts)
		expect(await local.blobs.has(hash)).toBe(false)
		// The demand side is what closes it, and closing it there is enough.
		expect(await read(volume(hydratingBlobs(local, remote)), '/notes.txt')).toBe('hello')
	})
})

describe('sync: lazy content', () => {
	it('takes the rows and not one byte', async () => {
		const { local, remote, there, opts } = pair()
		await there.writeFile('/notes.txt', enc.encode('hello'))
		const peer = trace(remote)

		await sync(local, peer.store, { ...opts, lazyContent: true })

		expect(peer.log.filter((call) => call.startsWith('get'))).toEqual([])
		expect(await local.child(ROOT, 'notes.txt')).not.toBeNull()
		// And the stub says so rather than reading as an empty file.
		await expect(volume(local).readFile('/notes.txt')).rejects.toThrow('ENOENT')
	})

	it('still pushes its own content, which only this replica holds', async () => {
		const { local, remote, here, opts } = pair()
		await here.writeFile('/mine.txt', enc.encode('hello'))

		await sync(local, remote, { ...opts, lazyContent: true })

		expect(await read(volume(remote), '/mine.txt')).toBe('hello')
	})
})

describe('hydratingBlobs', () => {
	it('reads a lazy stub through the peer, and holds the bytes afterwards', async () => {
		const { local, remote, there, opts } = pair()
		await there.writeFile('/notes.txt', enc.encode('hello'))
		await sync(local, remote, { ...opts, lazyContent: true })
		const hash = await hashOf('hello')
		const peer = trace(remote)

		expect(await read(volume(hydratingBlobs(local, peer.store)), '/notes.txt')).toBe('hello')

		expect(peer.log).toEqual([`get ${hash}`])
		expect(await local.blobs.has(hash)).toBe(true)
		// Cached, so the second read never leaves this replica.
		expect(await read(volume(hydratingBlobs(local, peer.store)), '/notes.txt')).toBe('hello')
		expect(peer.log.filter((call) => call.startsWith('get'))).toEqual([`get ${hash}`])
	})

	it('answers null when neither side holds the bytes', async () => {
		const { local, remote } = pair()

		expect(await hydratingBlobs(local, remote).blobs.get(await hashOf('nowhere'))).toBeNull()
	})

	it('refuses bytes that do not hash to the key', async () => {
		const { local, remote, there, opts } = pair()
		await there.writeFile('/notes.txt', enc.encode('hello'))
		await sync(local, remote, { ...opts, lazyContent: true })
		const hash = await hashOf('hello')

		await expect(hydratingBlobs(local, liar(remote)).blobs.get(hash)).rejects.toThrow(/do not hash/)
		expect(await local.blobs.has(hash)).toBe(false)
	})

	it('leaves every other seam call to the store it wraps', async () => {
		const { local, remote, here } = pair()
		await here.writeFile('/mine.txt', enc.encode('hello'))
		const hydrating = hydratingBlobs(local, remote)

		// A write goes local, and `has` stays a local question — "do I hold these
		// bytes" is what the engine asks it before deciding to transfer any.
		expect(await hydrating.child(ROOT, 'mine.txt')).toEqual(await local.child(ROOT, 'mine.txt'))
		expect(await hydrating.blobs.has(await hashOf('hello'))).toBe(true)
		expect(await hydrating.blobs.has(await hashOf('elsewhere'))).toBe(false)

		// Every seam call but one: `close` belongs to whoever CONSTRUCTED the store, and
		// this wrapper constructed nothing. Forwarding it would let a reader end the
		// store its other holders are still using.
		let closed = false
		const owning = {
			...local,
			close: async (): Promise<void> => {
				closed = true
			}
		}
		expect(hydratingBlobs(owning, remote).close).toBeUndefined()
		expect(closed).toBe(false)
	})
})
