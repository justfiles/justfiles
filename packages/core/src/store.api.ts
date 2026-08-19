/**
 * The seam as routes, over any injected `Store`. One route per seam call and
 * nothing else — this is the wire the design means when it says the storage API
 * and the wire are the same thing, so an addition here needs a design review
 * that starts with "why can this not be rows?".
 *
 * It routes and it sets status codes. It does not decide policy: the tree
 * invariants, the serialization and the blob verification all belong to the
 * store it is handed (`authority()` in `packages/fs`), and so does auth, which
 * is middleware the host puts in front of the mount. That split is what lets the
 * conformance suite run over this wire against a raw store — the contract is the
 * contract, and the wire adds nothing to it.
 *
 * Three statuses carry the meaning a caller acts on, and everything else is a
 * plain failure:
 *
 * - **409** a commit was refused — a guard, or an invariant no `Guard` states.
 *   The body names it, and `httpStore` turns it back into `GuardError`.
 * - **410** the cursor belongs to another lineage (rule 11).
 * - **400** the request contradicts itself: a malformed row, or bytes that do
 *   not hash to the key they were offered under.
 *
 * It lives in `packages/core` because it is server code; `packages/fs` stays
 * dependency-free.
 */

import { decodeCommit, encodeNode } from '@justfiles/fs/http'
import {
	ForeignCursorError,
	GuardError,
	HashMismatchError,
	type Node,
	type Page,
	type Store
} from '@justfiles/fs/store'
import { type Context, Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

export function storeApi(store: Store): Hono {
	const app = new Hono()

	app.onError((err, c) => {
		// A refusal is not a failure. The reason travels because the caller acts on
		// it — read again and replan — rather than reporting it.
		if (err instanceof GuardError) return c.json({ error: 'guard', reason: err.reason }, 409)
		if (err instanceof ForeignCursorError) return c.json({ error: 'lineage' }, 410)
		if (err instanceof HashMismatchError)
			return c.json({ error: 'hash', message: err.message }, 400)
		if (err instanceof HTTPException) return err.getResponse()
		return c.json({ error: 'store', message: err.message }, 500)
	})

	// The two lookups over the one table. `null` is an answer, not a 404: the
	// store's own answer to "is there a row" is `null`, and the one 404 on this
	// API is a blob that is not here.
	app.get('/node/:id', async (c) => c.json(row(await store.get(c.req.param('id')))))
	app.get('/child', async (c) => c.json(row(await store.child(need(c, 'parent'), need(c, 'name')))))
	app.get('/children', async (c) =>
		c.json(page(await store.children(need(c, 'parent'), c.req.query('cursor'))))
	)

	// The one ordering. An absent `cursor` is the empty cursor — where every scan
	// starts — so it is missing rather than blank.
	app.get('/since', async (c) => c.json(page(await store.since(c.req.query('cursor')))))

	// The one write. Strictly decoded, on the same reasoning that makes a
	// peer-facing store verify a hash (rule 7): a peer's rows are the one way a
	// malformed row could enter the table everyone converges on.
	app.post('/commit', async (c) => {
		const batch = await c.req.json().then(decodeCommit).catch(badRequest)
		await store.commit(batch.writes, batch.guards)
		return c.body(null, 204)
	})

	// The one content map: hash-keyed and immutable (rule 7).
	app.get('/blob/:hash', async (c) => {
		const hash = c.req.param('hash')
		// Hono answers a HEAD by running the GET and dropping the body, so `has` is
		// answered HERE — before anything reads bytes the caller does not want.
		if (c.req.method === 'HEAD') return c.body(null, (await store.blobs.has(hash)) ? 200 : 404)
		const data = await store.blobs.get(hash)
		if (data === null) return c.body(null, 404)
		return c.body(buffer(data), 200, { 'content-type': 'application/octet-stream' })
	})

	app.put('/blob/:hash', async (c) => {
		// Whether the bytes must hash to the key is the STORE's business: a
		// peer-facing one is wrapped in `verifiedBlobs` and says so with a
		// `HashMismatchError`, which is the 400 above.
		await store.blobs.put(c.req.param('hash'), new Uint8Array(await c.req.arrayBuffer()))
		return c.body(null, 204)
	})

	return app
}

const row = (node: Node | null) => (node === null ? null : encodeNode(node))

/** `next` is dropped when it is absent, so a caught-up page reads as one. */
const page = (found: Page) => ({ nodes: found.nodes.map(encodeNode), next: found.next })

const need = (c: Context, name: string): string =>
	c.req.query(name) ?? badRequest(`missing query parameter ${name}`)

const badRequest = (reason: unknown): never => {
	throw new HTTPException(400, {
		message: reason instanceof Error ? reason.message : String(reason)
	})
}

/** A copy as a plain `ArrayBuffer`: what a body takes, and it cannot alias the store's array. */
const buffer = (data: Uint8Array): ArrayBuffer => {
	const body = new ArrayBuffer(data.byteLength)
	new Uint8Array(body).set(data)
	return body
}
