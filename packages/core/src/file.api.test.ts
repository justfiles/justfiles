/**
 * The one convenience route. What it must get right is what a caller cannot see from
 * the seam: that a path is a path however the host mounted this, and that the two
 * failures a caller acts on are told apart from a server that broke.
 */

import { announceMount, volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { ROOT } from '@justfiles/fs/store'
import { Hono } from 'hono'
import { describe, expect, test } from 'vitest'
import { fileApi } from './file.api'

const enc = new TextEncoder()

const served = async (files: Record<string, string>, mount?: string) => {
	const store = memStore()
	if (mount !== undefined) await announceMount(store, ROOT, mount)
	const vol = volume(store)
	for (const [path, body] of Object.entries(files)) {
		const dir = path.slice(0, path.lastIndexOf('/'))
		if (dir !== '') await vol.mkdir(dir, { recursive: true })
		await vol.writeFile(path, enc.encode(body))
	}
	// Mounted under a prefix, because that is how a host uses it — and the route reads
	// the path from a named catch-all rather than from the request's own URL.
	return new Hono().route('/store', fileApi(vol))
}

describe('fileApi', () => {
	test('one request, the bytes, and a content type read off the name', async () => {
		const app = await served({ '/notes/a.md': 'note body' })

		const res = await app.request('/store/file/notes/a.md')

		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
		expect(await res.text()).toBe('note body')
	})

	test('a name is a name: the escaping survives the round trip', async () => {
		const app = await served({ '/notes/a b&c.txt': 'spaced' })

		expect(await (await app.request('/store/file/notes/a%20b%26c.txt')).text()).toBe('spaced')
	})

	test('the two answers a caller acts on', async () => {
		const app = await served({ '/notes/a.md': 'x' })

		expect((await app.request('/store/file/notes/missing.md')).status).toBe(404)
		// A directory is not a file, and saying 404 would have the caller believe the
		// path is free.
		expect((await app.request('/store/file/notes')).status).toBe(400)
	})

	test('an unbound mount reads as the empty directory it is', async () => {
		// This is what keeps the host's own store off the route: `storeApi` is handed
		// the synced store alone, and so is the volume under this.
		const app = await served({ '/notes/a.md': 'x' }, 'private')

		expect((await app.request('/store/file/private/accounts.json')).status).toBe(404)
	})
})
