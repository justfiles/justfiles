/**
 * The wire, held to the seam's own contract.
 *
 * The conformance suite runs FIRST and it is the point of this file: the same
 * behaviour tests every backend passes, run against `httpStore` whose fetch is
 * the Hono app's — one contract, no capability negotiation, and the design's
 * claim that "a remote peer is just another `Store`" proven rather than
 * asserted. The store behind the routes is `memStore` because the wire is
 * transparent to what is under it: T12 already ran the same suite against the
 * durable backend directly.
 *
 * What the cases below the suite add is what only a WIRE can be wrong about —
 * the status codes, and the fact that a refusal survives the round trip as the
 * typed error the engine turns on. The last one is the whole story end to end:
 * two `httpStore` clients, one authority hub, and a conflict settled by the
 * replan from T10 with an HTTP boundary in the middle.
 */

import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { authority } from '../../fs/authority'
import { type CursorSlot, sync, versions } from '../../fs/engine'
import {
	type Cursor,
	ForeignCursorError,
	GuardError,
	type Node,
	ROOT,
	type Store,
	sha256Hex
} from '../../fs/store'
import { storeConformance } from '../../fs/store.conformance'
import { httpStore } from '../../fs/store.http'
import { memStore } from '../../fs/store.mem'
import { storeVolume } from '../../fs/volume.store'
import { storeApi } from './store.api'

const enc = new TextEncoder()
const dec = new TextDecoder()

/**
 * A `Store` a URL away, with no socket in between: the server IS a fetch
 * handler, so wiring the two in-process is the honest test of the wire and not a
 * mock of it. Mounted under a path, as a host mounts it — the client's base URL
 * is the only place that knows where.
 */
const served = (store: Store): { ask: Ask; client: Store } => {
	const host = new Hono().route('/store', storeApi(store))
	// `app.request` may answer synchronously; a fetch never does.
	const ask: Ask = async (path, init) => host.request(`/store${path}`, init)
	return {
		ask,
		client: httpStore('http://hub.test/store', {
			fetch: async (url, init) => host.request(url, init)
		})
	}
}

/** A raw request at the mounted API, for the cases that are about the STATUS. */
type Ask = (path: string, init?: RequestInit) => Promise<Response>

storeConformance('httpStore over memStore', async () => served(memStore()).client)

const node = (over: Partial<Node> & Pick<Node, 'id' | 'name'>): Node => ({
	parent: ROOT,
	type: 'file',
	mode: 0o100644,
	mtimeNs: 0n,
	size: 0n,
	version: '1',
	...over
})

/** A commit as the wire carries it: bigints as decimal strings. */
const wire = (...writes: Node[]) => ({
	writes: writes.map((row) => ({ ...row, mtimeNs: String(row.mtimeNs), size: String(row.size) }))
})

const post = (ask: Ask, body: unknown) =>
	ask('/commit', {
		method: 'POST',
		body: JSON.stringify(body),
		headers: { 'content-type': 'application/json' }
	})

describe('storeApi: what the wire answers', () => {
	it('answers a refused guard with a 409 that names the guard', async () => {
		const store = memStore()
		const { ask, client } = served(store)
		await store.commit([node({ id: 'held', name: 'taken.txt' })])

		const guard = { free: { parent: ROOT, name: 'taken.txt' } }
		const res = await post(ask, { ...wire(node({ id: 'a', name: 'a.txt' })), guards: [guard] })
		// A refusal is not a failure: 409, and the body says which guard did not
		// hold, so a caller can tell "read again and replan" from "this peer is
		// broken" without parsing a message.
		expect(res.status).toBe(409)
		expect(await res.json()).toEqual({ error: 'guard', reason: guard })
		// And the commit wrote nothing (rule 2).
		expect(await store.get('a')).toBeNull()

		// The client turns that status back into the ONE type the engine replans on.
		await expect(client.commit([node({ id: 'a', name: 'a.txt' })], [guard])).rejects.toThrow(
			GuardError
		)
	})

	it('answers a foreign-lineage cursor with a 410, and the client throws ForeignCursorError', async () => {
		const mine = served(memStore())
		const other = served(memStore())
		const { next: cursor } = await mine.client.since()
		if (cursor === undefined) throw new Error('since must always hand a cursor back')

		// Rule 11: no position in that store answers to this cursor, ever — so the
		// status is Gone, and the client restarts from the empty cursor.
		const res = await other.ask(`/since?cursor=${encodeURIComponent(cursor)}`)
		expect(res.status).toBe(410)
		await expect(other.client.since(cursor)).rejects.toThrow(ForeignCursorError)
		expect((await other.client.since()).nodes.map((n) => n.id)).toEqual([ROOT])
	})

	it('refuses a malformed row with a 400 and writes nothing', async () => {
		const store = memStore()
		const { ask } = served(store)

		// The same reasoning as verifying a blob's hash (rule 7): this store takes
		// writes from a peer, and nothing under it type-checks a row — the authority
		// checks the TREE, not the fields — so a malformed row admitted here would
		// replicate to every replica that syncs.
		for (const body of [
			{ writes: [{ id: 'x', name: 'x.txt' }] }, // missing fields
			{ writes: [{ ...wire(node({ id: 'x', name: 'x.txt' })).writes[0], type: 'banana' }] },
			{ writes: [{ ...wire(node({ id: 'x', name: 'x.txt' })).writes[0], mtimeNs: 12 }] },
			{ writes: 'not an array' },
			{ ...wire(node({ id: 'x', name: 'x.txt' })), guards: [{ nothing: true }] }
		]) {
			expect((await post(ask, body)).status).toBe(400)
			expect(await store.get('x')).toBeNull()
		}
	})

	it('carries a pre-epoch mtime, and still refuses a negative size', async () => {
		const store = memStore()
		const { ask, client } = served(store)

		// A time before 1970 is an ordinary POSIX time: `utimes` puts the caller's
		// bigint straight into the row, and every other backend keeps it. A wire that
		// refused one would be the only store with a narrower contract than the seam.
		const old = node({ id: 'old', name: 'old.txt', mtimeNs: -1_000_000_000n })
		await client.commit([old])
		expect(await client.get('old')).toEqual(old)
		expect(await store.get('old')).toEqual(old)

		// A size cannot be negative, and a store is better off saying so.
		const res = await post(ask, {
			writes: [{ ...wire(node({ id: 'x', name: 'x.txt' })).writes[0], size: '-1' }]
		})
		expect(res.status).toBe(400)
		expect(await store.get('x')).toBeNull()
	})

	it('answers bytes that do not hash to their key with a 400, and stores nothing', async () => {
		// A peer-facing store verifies its own content (rule 7) — `authority` is
		// where that wrapper goes — and the wire answers that refusal as the client
		// error it is: the request was wrong, not the store.
		const store = memStore()
		const { ask, client } = served(authority(store))
		const hash = await sha256Hex(enc.encode('hello'))

		const res = await ask(`/blob/${hash}`, { method: 'PUT', body: enc.encode('goodbye') })
		expect(res.status).toBe(400)
		expect(await store.blobs.has(hash)).toBe(false)
		await expect(client.blobs.put(hash, enc.encode('goodbye'))).rejects.toThrow()
		expect(await client.blobs.has(hash)).toBe(false)

		// The honest bytes land, and come back by hash.
		await client.blobs.put(hash, enc.encode('hello'))
		expect(await client.blobs.get(hash)).toEqual(enc.encode('hello'))
	})

	it('answers an invariant-breaking commit with a 409, over the same route as a guard', async () => {
		const hub = authority(memStore())
		const { ask, client } = served(hub)
		const file = node({ id: 'f', name: 'f.txt' })
		await hub.commit([file])

		// Rule 9 lives at the authority, and no `Guard` states it. It still reaches
		// the client as the same event: the commit was refused, read again and replan.
		const res = await post(ask, wire(node({ id: 'kid', name: 'kid.txt', parent: 'f' })))
		expect(res.status).toBe(409)
		expect(await res.json()).toMatchObject({ error: 'guard' })
		await expect(
			client.commit([node({ id: 'kid', name: 'kid.txt', parent: 'f' })])
		).rejects.toThrow(GuardError)
		expect(await client.get('kid')).toBeNull()
	})
})

/** The host-local cursor slot. A variable is the whole contract (see T8). */
function slot(): CursorSlot {
	let at: Cursor | undefined
	return {
		load: async () => at,
		save: async (cursor) => {
			at = cursor
		}
	}
}

/** One replica: its own store, its cursors, and the POSIX view its user writes through. */
function replica(id: string) {
	const store = memStore()
	return {
		store,
		opts: { replica: id, pull: slot(), push: slot() },
		vol: storeVolume(store, { mintVersion: versions(id) })
	}
}

const read = async (store: Store, path: string): Promise<string> =>
	dec.decode(await storeVolume(store).readFile(path))

describe('sync over the wire', () => {
	it('replans a conflict the hub refused, with an HTTP boundary in the middle', async () => {
		// The topology the design names for a client–server star, with the seam's
		// own wire between the parts: two replicas, one authority hub, and every
		// call the engine makes — `since`, `commit` with its guards, the `child`
		// probes a settlement takes, the blob transfer — over HTTP.
		const hub = authority(memStore())
		// A client each, as two devices hold them: a `Store` handle carries no state
		// of its own, so what makes them two replicas is their cursors, not their
		// connections.
		const fromA = served(hub).client
		const fromB = served(hub).client
		const a = replica('a')
		const b = replica('b')
		await a.vol.writeFile('/note.txt', enc.encode('from a'))
		await b.vol.writeFile('/note.txt', enc.encode('from b'))

		await sync(a.store, fromA, a.opts)
		// b's push is refused with a 409, so it reads the hub again, renames its own
		// node and pushes that — the replan from T10, unchanged by the wire.
		await sync(b.store, fromB, b.opts)
		await sync(a.store, fromA, a.opts)

		for (const store of [hub, a.store, b.store]) {
			expect((await storeVolume(store).readdir('/')).map((e) => e.name).sort()).toEqual([
				'note.txt',
				'note.txt (conflict b)'
			])
			expect(await read(store, '/note.txt')).toBe('from a')
			expect(await read(store, '/note.txt (conflict b)')).toBe('from b')
		}
	})
})
