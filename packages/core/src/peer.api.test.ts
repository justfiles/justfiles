import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { httpStore } from '../../fs/http'
import { memStore } from '../../fs/mem'
import { BootstrapRequiredError } from '../../fs/peer'
import { type Cursor, type Node, ROOT } from '../../fs/store'
import { syncStoreApi } from './store.api'

const node = (id: string): Node => ({
	id,
	parent: ROOT,
	name: `${id}.txt`,
	type: 'file',
	mode: 0o100644,
	mtimeNs: 0n,
	size: 0n,
	version: 'peer:1'
})

const caughtUp = async (peer: ReturnType<typeof httpStore>): Promise<Cursor> => {
	let cursor: Cursor | undefined
	for (;;) {
		const page = await peer.since(cursor)
		if (!page.next) throw new Error('peer did not return a cursor')
		cursor = page.next
		if (page.nodes.length === 0) return cursor
	}
}

describe('store HTTP cursor protocol', () => {
	it('carries the receiver cursor on every write', async () => {
		const store = memStore()
		const app = new Hono().route('/store', syncStoreApi(store))
		let alter = false
		const peer = httpStore('http://peer.test/store', {
			fetch: async (url, init) => {
				if (!alter) return app.request(url, init)
				const headers = new Headers(init?.headers)
				const cursor = headers.get('x-sync-cursor')
				if (cursor) headers.set('x-sync-cursor', `${cursor}x`)
				return app.request(url, { ...init, headers })
			}
		})
		await caughtUp(peer)

		await peer.commit([node('accepted')])
		expect(await store.get('accepted')).toEqual(node('accepted'))

		alter = true
		await expect(peer.commit([node('refused')])).rejects.toThrow(BootstrapRequiredError)
		expect(await store.get('refused')).toBeNull()
	})

	it('rejects peer operations which carry no cursor', async () => {
		const store = memStore()
		const app = new Hono().route('/store', syncStoreApi(store))
		const peer = httpStore('http://peer.test/store', {
			fetch: async (url, init) => app.request(url, init)
		})

		await expect(peer.get(ROOT)).rejects.toThrow(BootstrapRequiredError)
		await expect(peer.commit([node('refused')])).rejects.toThrow(BootstrapRequiredError)
		expect(await store.get('refused')).toBeNull()
	})
})
