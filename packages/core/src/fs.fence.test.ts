// Push fencing. A mutating /fs request carries the client's `x-fs-generation`; a
// present-but-stale value is rejected with `409 generation_stale` and the write
// does NOT land. Covers the server enforcement AND both client paths (path-sync
// `remoteSyncReplica` + the inode `apiStorage`), which stamp the header and
// surface the 409 as a typed error.

import { memStorage, volume } from '@justfiles/fs'
import { GenerationStaleError, LineageStaleError } from '@justfiles/fs/sync-replica'
import type { PathChange } from '@justfiles/fs/sync-wire'
import { FileType } from '@justfiles/fs/types'
import { describe, expect, it } from 'vitest'
import { createFsApi, type ResetBody, type ResetResult } from './fs'
import { apiStorage, createFsClient, remoteSyncReplica } from './fs.client'

async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer)
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}

// A real FsClient talking to a createFsApi app in-process (its Hono request
// handler is the transport), so the client stamps real headers and the server
// runs its real fence middleware.
function wireClient(app: ReturnType<typeof createFsApi>) {
	return createFsClient({
		baseUrl: 'http://fence.test',
		fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
			app.request(input as string, init)) as unknown as typeof fetch
	})
}

const dirPut = (path: string): PathChange => ({
	kind: 'put',
	path,
	version: '1',
	meta: { type: FileType.Directory, mode: 0o755, mtimeNs: '0', size: '0' }
})

describe('/fs push fencing — server', () => {
	it('surfaces the generation on the handshake', async () => {
		const app = createFsApi(memStorage(), { lineage: () => ({ generation: 5 }) })
		const res = await app.request('/', { method: 'GET' })
		expect(res.status).toBe(200)
		expect((await res.json()).generation).toBe(5)
	})

	it('rejects a stale mutating write and does not apply it', async () => {
		const backend = memStorage()
		const app = createFsApi(backend, { lineage: () => ({ generation: 5 }) })
		const data = new Uint8Array([1, 2, 3])
		const hash = await sha256Hex(data)
		const res = await app.request(`/blob/${hash}`, {
			method: 'PUT',
			body: data,
			headers: { 'Content-Type': 'application/octet-stream', 'x-fs-generation': '4' }
		})
		expect(res.status).toBe(409)
		expect(await res.json()).toEqual({ error: 'generation_stale', generation: 5 })
		// The write did not land.
		const head = await app.request(`/blob/${hash}`, { method: 'HEAD' })
		expect(head.status).toBe(404)
	})

	it('accepts a mutating write at the current generation', async () => {
		const backend = memStorage()
		const app = createFsApi(backend, { lineage: () => ({ generation: 5 }) })
		const data = new Uint8Array([9])
		const hash = await sha256Hex(data)
		const res = await app.request(`/blob/${hash}`, {
			method: 'PUT',
			body: data,
			headers: { 'Content-Type': 'application/octet-stream', 'x-fs-generation': '5' }
		})
		expect(res.status).toBe(204)
		expect((await app.request(`/blob/${hash}`, { method: 'HEAD' })).status).toBe(200)
	})

	it('allows a mutating write with no generation header (legacy client)', async () => {
		const backend = memStorage()
		const app = createFsApi(backend, { lineage: () => ({ generation: 5 }) })
		const data = new Uint8Array([7])
		const hash = await sha256Hex(data)
		const res = await app.request(`/blob/${hash}`, {
			method: 'PUT',
			body: data,
			headers: { 'Content-Type': 'application/octet-stream' }
		})
		expect(res.status).toBe(204)
	})

	it('does not fence when no generation source is configured', async () => {
		const backend = memStorage()
		const app = createFsApi(backend) // no generation opt
		const data = new Uint8Array([7])
		const hash = await sha256Hex(data)
		const res = await app.request(`/blob/${hash}`, {
			method: 'PUT',
			body: data,
			headers: { 'Content-Type': 'application/octet-stream', 'x-fs-generation': '999' }
		})
		expect(res.status).toBe(204)
	})

	it('does not fence reads', async () => {
		const app = createFsApi(memStorage(), { lineage: () => ({ generation: 5 }) })
		const res = await app.request('/', { method: 'GET', headers: { 'x-fs-generation': '1' } })
		expect(res.status).toBe(200)
	})
})

// Identity fencing (issue #245): `generation` alone can't tell two fresh volumes
// apart (both seed to 1), so a mutating write also carries `x-fs-lineage`. A push
// aimed at a DIFFERENT volume at the same generation is rejected on a lineage
// mismatch — preventing cross-volume contamination.
describe('/fs identity fencing — server', () => {
	it('surfaces the lineageId on the handshake', async () => {
		const app = createFsApi(memStorage(), {
			lineage: () => ({ generation: 5, lineageId: 'vol-A' })
		})
		expect((await (await app.request('/', { method: 'GET' })).json()).lineageId).toBe('vol-A')
	})

	it('rejects a write whose lineage differs at the same generation, and does not apply it', async () => {
		const backend = memStorage()
		const app = createFsApi(backend, { lineage: () => ({ generation: 5, lineageId: 'vol-A' }) })
		const data = new Uint8Array([1, 2, 3])
		const hash = await sha256Hex(data)
		const res = await app.request(`/blob/${hash}`, {
			method: 'PUT',
			body: data,
			headers: {
				'Content-Type': 'application/octet-stream',
				'x-fs-generation': '5', // generation matches — only the lineage differs
				'x-fs-lineage': 'vol-B'
			}
		})
		expect(res.status).toBe(409)
		expect(await res.json()).toEqual({ error: 'lineage_stale', generation: 5, lineageId: 'vol-A' })
		expect((await app.request(`/blob/${hash}`, { method: 'HEAD' })).status).toBe(404)
	})

	it('accepts a write whose lineage matches', async () => {
		const backend = memStorage()
		const app = createFsApi(backend, { lineage: () => ({ generation: 5, lineageId: 'vol-A' }) })
		const data = new Uint8Array([9])
		const hash = await sha256Hex(data)
		const res = await app.request(`/blob/${hash}`, {
			method: 'PUT',
			body: data,
			headers: {
				'Content-Type': 'application/octet-stream',
				'x-fs-generation': '5',
				'x-fs-lineage': 'vol-A'
			}
		})
		expect(res.status).toBe(204)
	})

	it('allows a write with no lineage header (only the generation is fenced)', async () => {
		const backend = memStorage()
		const app = createFsApi(backend, { lineage: () => ({ generation: 5, lineageId: 'vol-A' }) })
		const data = new Uint8Array([7])
		const hash = await sha256Hex(data)
		const res = await app.request(`/blob/${hash}`, {
			method: 'PUT',
			body: data,
			headers: { 'Content-Type': 'application/octet-stream', 'x-fs-generation': '5' }
		})
		expect(res.status).toBe(204)
	})
})

// The advisory "reset in progress" flag (resetId) is exposed on the handshake so
// other devices can show status / gate their own reset UI. It is NOT a write lock
// (a take-mine republish rides ordinary sync at the new generation).
describe('/fs reset flag — server', () => {
	it('surfaces resetId on the handshake', async () => {
		const app = createFsApi(memStorage(), { lineage: () => ({ generation: 6, resetId: 'r1' }) })
		const data = await (await app.request('/', { method: 'GET' })).json()
		expect(data).toMatchObject({ generation: 6, resetId: 'r1' })
	})

	it('does not fence a write while a reset is in progress (no publishing lock)', async () => {
		const backend = memStorage()
		const app = createFsApi(backend, { lineage: () => ({ generation: 6, resetId: 'r1' }) })
		const data = new Uint8Array([4, 2])
		const hash = await sha256Hex(data)
		// A write at the current generation is admitted even though resetId is set.
		const res = await app.request(`/blob/${hash}`, {
			method: 'PUT',
			body: data,
			headers: { 'Content-Type': 'application/octet-stream', 'x-fs-generation': '6' }
		})
		expect(res.status).toBe(204)
		expect((await app.request(`/blob/${hash}`, { method: 'HEAD' })).status).toBe(200)
	})
})

// Reset is a first-class /fs route over a HOST-INJECTED capability (the CAS +
// truncate needs the host's raw store). The library only owns the envelope: it
// validates the body, delegates, and maps the result to 200/409 — and registers
// the route AHEAD of the fence, so a stale client (exactly the one that needs to
// reset) still reaches the capability's own CAS.
describe('/fs reset route — server', () => {
	const capability = (generation: number) => ({
		lineage: () => ({ generation }),
		reset: async (req: ResetBody): Promise<ResetResult> =>
			req.mode === 'complete' || req.fromGeneration === generation
				? { ok: true, generation: generation + 1 }
				: { ok: false, error: 'generation_stale' as const, generation }
	})

	it('delegates to the injected capability and returns the new generation', async () => {
		const app = createFsApi(memStorage(), capability(5))
		const res = await app.request('/reset', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				mode: 'adopt-mine',
				fromGeneration: 5,
				operationId: 'op-1',
				resetId: 'r1'
			})
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ generation: 6 })
	})

	it('409s when the capability rejects the CAS', async () => {
		const app = createFsApi(memStorage(), capability(5))
		const res = await app.request('/reset', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				mode: 'adopt-mine',
				fromGeneration: 4,
				operationId: 'op-1',
				resetId: 'r1'
			})
		})
		expect(res.status).toBe(409)
		expect(await res.json()).toEqual({ error: 'generation_stale', generation: 5 })
	})

	it('501s when the host injects no reset capability', async () => {
		const app = createFsApi(memStorage(), { lineage: () => ({ generation: 5 }) })
		const res = await app.request('/reset', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ mode: 'complete', resetId: 'r1' })
		})
		expect(res.status).toBe(501)
	})

	// The fence-exemption guard: reset is registered before the push fence, so a
	// STALE generation header does not 409 it — the capability's CAS decides.
	it('is exempt from the push fence (a stale header still reaches the capability)', async () => {
		const app = createFsApi(memStorage(), capability(5))
		const res = await app.request('/reset', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-fs-generation': '1' },
			body: JSON.stringify({
				mode: 'adopt-mine',
				fromGeneration: 5,
				operationId: 'op-1',
				resetId: 'r1'
			})
		})
		expect(res.status).toBe(200) // NOT the fence's 409
		expect(await res.json()).toEqual({ generation: 6 })
	})

	it('remoteSyncReplica.reset drives the route (adopt-mine → generation, complete → {})', async () => {
		const calls: ResetBody[] = []
		const app = createFsApi(memStorage(), {
			lineage: () => ({ generation: 5 }),
			reset: async (req) => {
				calls.push(req)
				return { ok: true, generation: 6 }
			}
		})
		// Stale on purpose: the replica stamps x-fs-generation, and reset must not be fenced.
		const replica = remoteSyncReplica(wireClient(app), { clientId: 'c1', generation: () => 1 })
		expect(
			await replica.reset?.({
				mode: 'adopt-mine',
				fromGeneration: 5,
				operationId: 'op-1',
				resetId: 'r1'
			})
		).toEqual({ generation: 6 })
		await replica.reset?.({ mode: 'complete', resetId: 'r1' })
		expect(calls).toEqual([
			{
				mode: 'adopt-mine',
				fromGeneration: 5,
				operationId: 'op-1',
				resetId: 'r1'
			},
			{ mode: 'complete', resetId: 'r1' }
		])
	})
})

describe('/fs push fencing — client paths', () => {
	it('remoteSyncReplica stamps the generation; a stale push throws GenerationStaleError', async () => {
		const backend = memStorage()
		const app = createFsApi(backend, { lineage: () => ({ generation: 5 }) })
		const client = wireClient(app)
		const noBlob = async () => new Uint8Array()

		const fresh = remoteSyncReplica(client, { clientId: 'c1', generation: () => 5 })
		await fresh.applyPathChanges([dirPut('/dir')], noBlob)
		expect(await volume(backend).exists('/dir')).toBe(true)

		const stale = remoteSyncReplica(client, { clientId: 'c1', generation: () => 4 })
		await expect(stale.applyPathChanges([dirPut('/dir2')], noBlob)).rejects.toBeInstanceOf(
			GenerationStaleError
		)
		expect(await volume(backend).exists('/dir2')).toBe(false)
	})

	it('apiStorage stamps the generation; a stale inode mutation throws GenerationStaleError', async () => {
		const backend = memStorage()
		const app = createFsApi(backend, { lineage: () => ({ generation: 5 }) })
		const client = wireClient(app)

		const fresh = await apiStorage(client, { generation: () => 5 })
		await fresh.setMeta('1', { mode: 0o700 }, {})

		const stale = await apiStorage(client, { generation: () => 4 })
		await expect(stale.setMeta('1', { mode: 0o700 }, {})).rejects.toBeInstanceOf(
			GenerationStaleError
		)
	})

	it('remoteSyncReplica stamps the lineageId; a mismatched-lineage push throws LineageStaleError', async () => {
		const backend = memStorage()
		const app = createFsApi(backend, { lineage: () => ({ generation: 5, lineageId: 'vol-A' }) })
		const client = wireClient(app)
		const noBlob = async () => new Uint8Array()

		// Generation matches, lineage matches → accepted.
		const same = remoteSyncReplica(client, {
			clientId: 'c1',
			generation: () => 5,
			lineageId: () => 'vol-A'
		})
		await same.applyPathChanges([dirPut('/dir')], noBlob)
		expect(await volume(backend).exists('/dir')).toBe(true)

		// Generation matches but we think we're on a different volume → fenced by identity.
		const wrongVolume = remoteSyncReplica(client, {
			clientId: 'c1',
			generation: () => 5,
			lineageId: () => 'vol-B'
		})
		await expect(wrongVolume.applyPathChanges([dirPut('/dir2')], noBlob)).rejects.toBeInstanceOf(
			LineageStaleError
		)
		expect(await volume(backend).exists('/dir2')).toBe(false)
	})
})
