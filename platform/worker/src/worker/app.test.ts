/**
 * The host's one claim: both routes stand over the SAME store.
 *
 * The seam's own behaviour is core's to prove (`store.api.test.ts` runs the whole
 * conformance suite over this wire). What is only this file's to get wrong is the
 * wiring — a `fileApi` built over a different store than `storeApi` would read an
 * empty tree and say ENOENT to a file the seam just accepted.
 */

import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { receiver } from '@justfiles/fs/peer'
import { expect, test } from 'vitest'
import { createWorkerApiApp } from './app'

test('a file written through the seam reads back through the one-request route', async () => {
	const store = memStore()
	const app = createWorkerApiApp({ store, peer: receiver(store) })
	const vol = volume(store)
	await vol.mkdir('/notes')
	await vol.writeFile('/notes/hello.md', new TextEncoder().encode('# hi'))

	const response = await app.request('/store/file/notes/hello.md')

	expect(response.status).toBe(200)
	expect(await response.text()).toBe('# hi')
})
