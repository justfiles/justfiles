// A create over the /fs wire (`apiStorage`) has to publish its bytes, and the server's
// own backend decides whether it can publish them BEFORE claiming the name.
//
// `PUT /blob/:hash` parks a blob that no inode references yet, which a backend without
// `caps.content` has nowhere to keep — it rejects. So the client NEGOTIATES rather than
// assuming: the handshake reports whether the server has a content store, and a create
// takes the atomic route only when it does. Either way the bytes are never lost, which
// is what the VFS handing them over relies on (it no longer fills the file afterwards).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memStorage, volume } from '@justfiles/fs'
import type { Storage } from '@justfiles/fs/storage'
import { nativeStorage } from '@justfiles/fs/storage/fs'
import { afterAll, expect, test } from 'vitest'
import { createFsApi } from './fs'
import { apiStorage, createFsClient } from './fs.client'

const enc = new TextEncoder()
const dec = new TextDecoder()

const dirs: string[] = []
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const wireVolume = async (backing: Storage) => {
	const app = createFsApi(backing)
	const client = createFsClient({
		baseUrl: 'http://create.test',
		fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
			app.request(input as string, init)) as unknown as typeof fetch
	})
	return volume(await apiStorage(client, { rootIno: backing.rootIno }))
}

test('a create round-trips over a server whose backend HAS a content store', async () => {
	const vol = await wireVolume(memStorage({ mintIno: () => crypto.randomUUID() }))
	await vol.writeFile('/note.md', enc.encode('hello'))
	expect(dec.decode(await vol.readFile('/note.md'))).toBe('hello')
})

test('a create round-trips over a server whose backend has NO content store', async () => {
	// `nativeStorage` is the shipped one: a mac daemon serving its own volume (#306).
	// Assuming the hash upload here made every create fail before reaching /inodes.
	const dir = mkdtempSync(join(tmpdir(), 'wire-'))
	dirs.push(dir)
	const vol = await wireVolume(await nativeStorage(dir))
	await vol.writeFile('/note.md', enc.encode('hello'))
	expect(dec.decode(await vol.readFile('/note.md'))).toBe('hello')
	// …including a payload past one write chunk, where a lost fill would be obvious.
	const big = 'y'.repeat(3 * 512 * 1024)
	await vol.writeFile('/big.md', enc.encode(big))
	expect(dec.decode(await vol.readFile('/big.md'))).toBe(big)
})

test('an exclusive claim over the wire still refuses a taken name on either server', async () => {
	for (const backing of [
		memStorage({ mintIno: () => crypto.randomUUID() }),
		await (async () => {
			const dir = mkdtempSync(join(tmpdir(), 'wire-'))
			dirs.push(dir)
			return nativeStorage(dir)
		})()
	]) {
		const vol = await wireVolume(backing)
		await vol.writeFile('/id', enc.encode('mine'), { exclusive: true })
		await expect(vol.writeFile('/id', enc.encode('theirs'), { exclusive: true })).rejects.toThrow(
			/^EEXIST/
		)
		expect(dec.decode(await vol.readFile('/id'))).toBe('mine')
	}
})
