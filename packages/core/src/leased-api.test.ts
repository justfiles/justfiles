import { leasedHttpStore } from '@justfiles/fs/leased-http'
import { memStore } from '@justfiles/fs/mem'
import { openMemLeased } from '@justfiles/fs/mem-leased'
import { type Node, ROOT } from '@justfiles/fs/store'
import { DEFAULT_SYNC_POLICY } from '@justfiles/fs/sync-policy'
import { bootstrap } from '@justfiles/fs/synced'
import { describe, expect, test } from 'vitest'
import { leasedStoreApi } from './leased-api'

const file = (id: string): Node => ({
	id,
	parent: ROOT,
	name: `${id}.txt`,
	type: 'file',
	mode: 0o100644,
	mtimeNs: 0n,
	size: 0n,
	version: 'a:1'
})

async function overHttp() {
	const held = await openMemLeased()
	const app = leasedStoreApi(held.peer)
	const remote = leasedHttpStore('http://peer.test/store', {
		fetch: async (url, init) => {
			const request = new URL(url)
			return app.request(`${request.pathname.slice('/store'.length)}${request.search}`, init)
		}
	})
	return { ...held, app, remote }
}

describe('leased HTTP peer', () => {
	test('signed cursors and write leases round-trip through the public wire', async () => {
		const { local, remote } = await overHttp()
		const cursor = await bootstrap(memStore(), remote)
		const lease = await remote.open(cursor)
		await remote.commit(lease, [file('sent')])

		expect(await local.get('sent')).toEqual(file('sent'))
		await expect(remote.since(`${cursor.slice(0, -1)}x`)).rejects.toThrow('bootstrap required')
	})

	test('raw HTTP writes cannot bypass lease verification', async () => {
		const { app, local } = await overHttp()
		const res = await app.request('/commit', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ writes: [] })
		})

		expect(res.status).toBe(428)
		expect(await local.get('sent')).toBeNull()
	})

	test('lease expiry is checked again on each blob and row request', async () => {
		const { clock, local, remote } = await overHttp()
		const cursor = await bootstrap(memStore(), remote)
		const lease = await remote.open(cursor)
		clock.advance(DEFAULT_SYNC_POLICY.maxWriteDurationMs + 1)

		await expect(remote.put(lease, 'hash', new Uint8Array([1]))).rejects.toThrow(
			'bootstrap required'
		)
		await expect(remote.commit(lease, [file('late')])).rejects.toThrow('bootstrap required')
		expect(await local.get('late')).toBeNull()
	})
})
