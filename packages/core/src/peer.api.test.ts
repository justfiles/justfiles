import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { httpStore } from '../../fs/http'
import { memStore } from '../../fs/mem'
import { BootstrapRequiredError, receiver } from '../../fs/peer'
import { type Cursor, type Node, ROOT } from '../../fs/store'
import { storeApi } from './store.api'

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

describe('leased store HTTP protocol', () => {
	it('carries the receiver lease on blob writes and commits', async () => {
		const store = memStore()
		const app = new Hono().route('/store', storeApi(receiver(store)))
		const peer = httpStore('http://peer.test/store', {
			fetch: async (url, init) => app.request(url, init)
		})
		const lease = await peer.open(await caughtUp(peer))

		await peer.commit(lease, [node('accepted')])
		expect(await store.get('accepted')).toEqual(node('accepted'))

		await expect(peer.commit(`${lease}x`, [node('refused')])).rejects.toThrow(
			BootstrapRequiredError
		)
		expect(await store.get('refused')).toBeNull()
	})
})
