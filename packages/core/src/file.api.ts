/**
 * One convenience route, and it is deliberately NOT part of the seam.
 *
 * `store.api.ts` is the wire: one route per seam call, and an addition there needs a
 * design review that starts with "why can this not be rows?". This is the answer for
 * the one consumer that is not a replica — a CLI reading a single file, a browser
 * pointing an `<img>` at one — for which a path walk is several round trips and a
 * `Range`-less blob fetch is another. It reads through a `Volume` and writes nothing,
 * so it can say nothing the seam does not; it only says it in one request.
 *
 * The host mounts it beside `storeApi`, wherever it puts that, and the path is read
 * from a named catch-all so the mount prefix is the host's business.
 */

import type { Volume } from '@justfiles/fs'
import { Hono } from 'hono'

export function fileApi(volume: Volume): Hono {
	const app = new Hono()

	app.get('/file/:path{.*}', async (c) => {
		const path = `/${c.req.param('path') ?? ''}`.replace(/\/+$/, '') || '/'
		try {
			return new Response(bytes(await volume.readFile(path)), {
				headers: { 'content-type': contentType(path) }
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			// The two a caller acts on. Anything else is a server that failed, and
			// saying so as a 404 would have the caller believe the file is gone.
			if (message.startsWith('ENOENT:')) return c.json({ error: message }, 404)
			if (message.startsWith('EISDIR:')) return c.json({ error: message }, 400)
			throw error
		}
	})

	return app
}

/** A copy as a plain `ArrayBuffer`: what a body takes, and it cannot alias the volume's. */
const bytes = (data: Uint8Array): ArrayBuffer => {
	const body = new ArrayBuffer(data.byteLength)
	new Uint8Array(body).set(data)
	return body
}

const contentType = (filename: string): string => {
	const lower = filename.toLowerCase()
	if (lower.endsWith('.png')) return 'image/png'
	if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
	if (lower.endsWith('.gif')) return 'image/gif'
	if (lower.endsWith('.webp')) return 'image/webp'
	if (lower.endsWith('.svg')) return 'image/svg+xml'
	if (lower.endsWith('.pdf')) return 'application/pdf'
	if (lower.endsWith('.json')) return 'application/json; charset=utf-8'
	if (lower.endsWith('.txt') || lower.endsWith('.md')) return 'text/plain; charset=utf-8'
	return 'application/octet-stream'
}
