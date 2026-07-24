// Regression: the `/fs/blob/:hash` GET and HEAD endpoints share ONE handler.
// Hono auto-routes HEAD to GET handlers, so a separate `.on('HEAD', …)` used to
// run the GET body for HEAD too and 500 on an absent blob (getBlobByHash throws)
// instead of reporting 404 — which broke push's `hasBlobByHash` presence check.

import { memStorage } from '@justfiles/fs'
import { PAGE } from '@justfiles/fs/sync-replica'
import { describe, expect, it } from 'vitest'
import { createFsApi } from './fs'
import { createFsClient, remoteSyncReplica } from './fs.client'

// SHA-256 of a known payload (never uploaded) — a guaranteed-absent blob.
const ABSENT = 'a'.repeat(64)

describe('/fs/blob/:hash presence', () => {
	it('reports missing blobs in one successful batch', async () => {
		const app = createFsApi(memStorage())
		const data = new Uint8Array([1, 2, 3, 4])
		const present = await sha256Hex(data)

		await app.request(`/blob/${present}`, {
			method: 'PUT',
			body: data,
			headers: { 'Content-Type': 'application/octet-stream' }
		})

		const res = await app.request('/blobs/missing', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ hashes: [present, ABSENT] })
		})

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ missing: [ABSENT] })
	})

	it('accepts one full sync page of hashes', async () => {
		const app = createFsApi(memStorage())
		const res = await app.request('/blobs/missing', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ hashes: Array<string>(PAGE).fill(ABSENT) })
		})

		expect(res.status).toBe(200)
	})

	it('checks remote blob presence without HEAD requests', async () => {
		const app = createFsApi(memStorage())
		const requests: string[] = []
		const client = createFsClient({
			baseUrl: 'http://blobs.test',
			fetch: (async (input, init) => {
				const request = new Request(input, init)
				requests.push(`${request.method} ${new URL(request.url).pathname}`)
				return app.request(request)
			}) as typeof fetch
		})
		const replica = remoteSyncReplica(client, { clientId: 'client' })
		if (!replica.missingBlobHashes) throw new Error('remote replica has no batch presence check')

		expect(await replica.missingBlobHashes([ABSENT])).toEqual(new Set([ABSENT]))
		expect(requests).toEqual(['POST /blobs/missing'])
	})

	it('HEAD returns 404 (not 500) for an absent blob', async () => {
		const app = createFsApi(memStorage())
		const res = await app.request(`/blob/${ABSENT}`, { method: 'HEAD' })
		expect(res.status).toBe(404)
	})

	it('GET returns 404 (not 500) for an absent blob', async () => {
		const app = createFsApi(memStorage())
		const res = await app.request(`/blob/${ABSENT}`, { method: 'GET' })
		expect(res.status).toBe(404)
	})

	it('HEAD then GET round-trip an uploaded blob', async () => {
		const app = createFsApi(memStorage())
		const data = new Uint8Array([1, 2, 3, 4])
		const hash = await sha256Hex(data)

		const put = await app.request(`/blob/${hash}`, {
			method: 'PUT',
			body: data,
			headers: { 'Content-Type': 'application/octet-stream' }
		})
		expect(put.status).toBe(204)

		const head = await app.request(`/blob/${hash}`, { method: 'HEAD' })
		expect(head.status).toBe(200)

		const get = await app.request(`/blob/${hash}`, { method: 'GET' })
		expect(get.status).toBe(200)
		expect(new Uint8Array(await get.arrayBuffer())).toEqual(data)
	})
})

async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer)
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}
