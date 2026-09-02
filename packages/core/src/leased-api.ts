/**
 * Leased store routes. Peer-facing writes require a validated write lease;
 * stale tokens answer 428 bootstrap-required.
 */

import { decodeCommit, encodeNode } from '@justfiles/fs/http'
import { BootstrapRequiredError, type LeasedPeer } from '@justfiles/fs/lease'
import {
	ForeignCursorError,
	GuardError,
	HashMismatchError,
	type Node,
	type Page
} from '@justfiles/fs/store'
import { type Context, Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

const LEASE = 'x-write-lease'

export function leasedStoreApi(store: LeasedPeer): Hono {
	const app = new Hono()
	app.use('*', async (c, next) => {
		c.header('cache-control', 'no-store')
		await next()
	})

	app.onError((err, c) => {
		if (err instanceof BootstrapRequiredError) return c.json({ error: 'bootstrap' }, 428)
		if (err instanceof GuardError) return c.json({ error: 'guard', reason: err.reason }, 409)
		if (err instanceof ForeignCursorError) return c.json({ error: 'lineage' }, 410)
		if (err instanceof HashMismatchError)
			return c.json({ error: 'hash', message: err.message }, 400)
		if (err instanceof HTTPException) return err.getResponse()
		return c.json({ error: 'store', message: err.message }, 500)
	})

	app.get('/node/:id', async (c) => c.json(row(await store.get(c.req.param('id')))))
	app.get('/child', async (c) => c.json(row(await store.child(need(c, 'parent'), need(c, 'name')))))
	app.get('/children', async (c) =>
		c.json(page(await store.children(need(c, 'parent'), c.req.query('cursor'))))
	)
	app.get('/since', async (c) => c.json(page(await store.since(c.req.query('cursor')))))

	app.post('/open', async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { cursor?: string }
		const lease = await store.open(body.cursor)
		return c.json({ lease })
	})

	app.post('/commit', async (c) => {
		const lease = c.req.header(LEASE)
		if (!lease) throw new BootstrapRequiredError()
		const batch = await c.req.json().then(decodeCommit).catch(badRequest)
		await store.commit(lease, batch.writes, batch.guards)
		return c.body(null, 204)
	})

	app.get('/blob/:hash', async (c) => {
		const hash = c.req.param('hash')
		if (c.req.method === 'HEAD') return c.body(null, (await store.blobs.has(hash)) ? 200 : 404)
		const data = await store.blobs.get(hash)
		if (data === null) return c.body(null, 404)
		return c.body(buffer(data), 200, { 'content-type': 'application/octet-stream' })
	})

	app.put('/blob/:hash', async (c) => {
		const lease = c.req.header(LEASE)
		if (!lease) throw new BootstrapRequiredError()
		await store.put(lease, c.req.param('hash'), new Uint8Array(await c.req.arrayBuffer()))
		return c.body(null, 204)
	})

	return app
}

const row = (node: Node | null) => (node === null ? null : encodeNode(node))
const page = (found: Page) => ({ nodes: found.nodes.map(encodeNode), next: found.next })
const need = (c: Context, name: string): string =>
	c.req.query(name) ?? badRequest(`missing query parameter ${name}`)
const badRequest = (reason: unknown): never => {
	throw new HTTPException(400, {
		message: reason instanceof Error ? reason.message : String(reason)
	})
}
const buffer = (data: Uint8Array): ArrayBuffer => {
	const body = new ArrayBuffer(data.byteLength)
	new Uint8Array(body).set(data)
	return body
}
