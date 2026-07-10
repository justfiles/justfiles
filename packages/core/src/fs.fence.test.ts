// Push fencing (docs/sync-reset-generation.md, step 2). A mutating /fs request
// carries the client's `x-fs-generation`; a present-but-stale value is rejected
// with `409 generation_stale` and the write does NOT land. Covers the server
// enforcement AND both client paths (path-sync `remoteSyncReplica` + the inode
// `apiStorage`), which stamp the header and surface the 409 as a typed error.

import { memStorage, volume } from '@justfiles/fs'
import { GenerationStaleError } from '@justfiles/fs/sync-replica'
import type { PathChange } from '@justfiles/fs/sync-wire'
import { FileType } from '@justfiles/fs/types'
import { describe, expect, it } from 'vitest'
import { createFsApi } from './fs'
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
		const app = createFsApi(memStorage(), { lineage: () => ({ generation: 5, publishing: false }) })
		const res = await app.request('/', { method: 'GET' })
		expect(res.status).toBe(200)
		expect((await res.json()).generation).toBe(5)
	})

	it('rejects a stale mutating write and does not apply it', async () => {
		const backend = memStorage()
		const app = createFsApi(backend, { lineage: () => ({ generation: 5, publishing: false }) })
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
		const app = createFsApi(backend, { lineage: () => ({ generation: 5, publishing: false }) })
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
		const app = createFsApi(backend, { lineage: () => ({ generation: 5, publishing: false }) })
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
		const app = createFsApi(memStorage(), { lineage: () => ({ generation: 5, publishing: false }) })
		const res = await app.request('/', { method: 'GET', headers: { 'x-fs-generation': '1' } })
		expect(res.status).toBe(200)
	})
})

// Finding 1 (gh#147): the adopt-mine publishing lock must be exposed on the
// handshake AND enforced — while held, only the owning resetId may mutate; every
// other writer is fenced so it can't clobber the half-published baseline.
describe('/fs publishing lock — server', () => {
	const locked = { generation: 6, resetId: 'owner-1', publishing: true }

	it('surfaces resetId + publishing on the handshake', async () => {
		const app = createFsApi(memStorage(), { lineage: () => locked })
		const data = await (await app.request('/', { method: 'GET' })).json()
		expect(data).toMatchObject({ generation: 6, resetId: 'owner-1', publishing: true })
	})

	it('echoes publishing on pull + snapshot pages', async () => {
		const app = createFsApi(memStorage(), { lineage: () => locked })
		const delta = await (await app.request('/path/changes?cursor=0', { method: 'GET' })).json()
		expect(delta.publishing).toBe(true)
		const scan = await (await app.request('/path/snapshot', { method: 'GET' })).json()
		expect(scan.publishing).toBe(true)
	})

	it('rejects a non-owner mutation while publishing and admits the owner', async () => {
		const backend = memStorage()
		const app = createFsApi(backend, { lineage: () => locked })
		const data = new Uint8Array([4, 2])
		const hash = await sha256Hex(data)

		// No reset-id header -> not the owner -> fenced (does not land).
		const nonOwner = await app.request(`/blob/${hash}`, {
			method: 'PUT',
			body: data,
			headers: { 'Content-Type': 'application/octet-stream', 'x-fs-generation': '6' }
		})
		expect(nonOwner.status).toBe(409)
		expect((await nonOwner.json()).error).toBe('publishing')
		expect((await app.request(`/blob/${hash}`, { method: 'HEAD' })).status).toBe(404)

		// Wrong reset-id -> still fenced.
		const wrongOwner = await app.request(`/blob/${hash}`, {
			method: 'PUT',
			body: data,
			headers: {
				'Content-Type': 'application/octet-stream',
				'x-fs-generation': '6',
				'x-fs-reset-id': 'someone-else'
			}
		})
		expect(wrongOwner.status).toBe(409)

		// Owner's write (matching x-fs-reset-id) is admitted.
		const owner = await app.request(`/blob/${hash}`, {
			method: 'PUT',
			body: data,
			headers: {
				'Content-Type': 'application/octet-stream',
				'x-fs-generation': '6',
				'x-fs-reset-id': 'owner-1'
			}
		})
		expect(owner.status).toBe(204)
		expect((await app.request(`/blob/${hash}`, { method: 'HEAD' })).status).toBe(200)
	})
})

describe('/fs push fencing — client paths', () => {
	it('remoteSyncReplica stamps the generation; a stale push throws GenerationStaleError', async () => {
		const backend = memStorage()
		const app = createFsApi(backend, { lineage: () => ({ generation: 5, publishing: false }) })
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
		const app = createFsApi(backend, { lineage: () => ({ generation: 5, publishing: false }) })
		const client = wireClient(app)

		const fresh = await apiStorage(client, { generation: () => 5 })
		await fresh.setMeta('1', { mode: 0o700 }, {})

		const stale = await apiStorage(client, { generation: () => 4 })
		await expect(stale.setMeta('1', { mode: 0o700 }, {})).rejects.toBeInstanceOf(
			GenerationStaleError
		)
	})
})
