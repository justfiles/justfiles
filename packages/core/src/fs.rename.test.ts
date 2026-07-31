// `rename(..., { exclusive: true })` over the /fs wire (`apiStorage`).
//
// This is the one place in the system where several REAL clients can reach for the same
// new name at once, so it is also the one place where deciding the claim client-side
// would be indefensible: a `getDirent` over the wire followed by a `POST /rename` is a
// TOCTOU a round trip wide. So the flag travels with the move and the SERVER's backend
// decides it — EEXIST comes back as 409 and is rethrown verbatim, because `claimPath`
// retries on that message (#330).
//
// The backing store here is `memStorage`, which settles a claim in one synchronous pass:
// what a client inherits is exactly the server store's isolation, so this is where that
// property is pinned rather than in the wire.

import { memStorage, volume } from '@justfiles/fs'
import type { Storage } from '@justfiles/fs/storage'
import { expect, test } from 'vitest'
import { createFsApi } from './fs'
import { apiStorage, createFsClient } from './fs.client'

const enc = new TextEncoder()
const dec = new TextDecoder()

const wireVolume = async (backing: Storage) => {
	const app = createFsApi(backing)
	const client = createFsClient({
		baseUrl: 'http://rename.test',
		fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
			app.request(input as string, init)) as unknown as typeof fetch
	})
	return volume(await apiStorage(client, { rootIno: backing.rootIno }))
}

const server = () => memStorage({ mintIno: () => crypto.randomUUID() })

// A server from BEFORE this flag, simulated the way one really behaves: its handshake has
// no `noReplaceRename`, and its Zod schema strips the unknown `noReplace` from the body, so
// `POST /rename` does the ordinary replacing rename and answers 200. Both halves matter —
// stripping alone is what turns a client's assumption into a destroyed file.
const oldWireVolume = async (backing: Storage) => {
	const app = createFsApi(backing)
	const client = createFsClient({
		baseUrl: 'http://rename.test',
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			let request = init
			if (new URL(url).pathname === '/rename' && init?.body !== undefined) {
				const { noReplace: _stripped, ...rest } = JSON.parse(String(init.body))
				request = { ...init, body: JSON.stringify(rest) }
			}
			const res = await app.request(url, request)
			if (new URL(url).pathname !== '/') return res
			const { noReplaceRename: _absent, ...handshake } = (await res.json()) as Record<
				string,
				unknown
			>
			return new Response(JSON.stringify(handshake), {
				status: res.status,
				headers: { 'Content-Type': 'application/json' }
			})
		}) as unknown as typeof fetch
	})
	return volume(await apiStorage(client, { rootIno: backing.rootIno }))
}

test('an exclusive move over the wire refuses a taken name and keeps both notes', async () => {
	const vol = await wireVolume(server())
	await vol.mkdir('/Inbox')
	await vol.writeFile('/Inbox/Kyoto.md', enc.encode('mine'))
	await vol.writeFile('/Kyoto.md', enc.encode('theirs'))
	await expect(vol.rename('/Inbox/Kyoto.md', '/Kyoto.md', { exclusive: true })).rejects.toThrow(
		/^EEXIST/
	)
	expect(dec.decode(await vol.readFile('/Kyoto.md'))).toBe('theirs')
	expect(dec.decode(await vol.readFile('/Inbox/Kyoto.md'))).toBe('mine')
	// Without the flag the wire keeps POSIX semantics: the destination is replaced.
	await vol.rename('/Inbox/Kyoto.md', '/Kyoto.md')
	expect(dec.decode(await vol.readFile('/Kyoto.md'))).toBe('mine')
})

test('an exclusive move against a server that predates the flag still refuses a taken name', async () => {
	// The failure this negotiation exists to prevent: the old server strips `noReplace`,
	// replaces the destination, and answers 200 — so a client that trusted the wire would
	// report a successful exclusive move over a note it had just destroyed. Asking first
	// costs one memoised handshake and keeps the refusal truthful.
	const vol = await oldWireVolume(server())
	await vol.mkdir('/Inbox')
	await vol.writeFile('/Inbox/Kyoto.md', enc.encode('mine'))
	await vol.writeFile('/Kyoto.md', enc.encode('theirs'))
	await expect(vol.rename('/Inbox/Kyoto.md', '/Kyoto.md', { exclusive: true })).rejects.toThrow(
		/^EEXIST/
	)
	expect(dec.decode(await vol.readFile('/Kyoto.md'))).toBe('theirs')
	expect(dec.decode(await vol.readFile('/Inbox/Kyoto.md'))).toBe('mine')
	// A free destination still moves, so an older server stays fully usable — what it loses
	// is the race, not the feature.
	await vol.rename('/Inbox/Kyoto.md', '/Osaka.md', { exclusive: true })
	expect(dec.decode(await vol.readFile('/Osaka.md'))).toBe('mine')
})

test('N clients racing for one name over the wire produce one winner, and lose nothing', async () => {
	// Each racer is its own `apiStorage` — separate clients against one server, which is
	// the shape a client-side check cannot survive.
	const backing = server()
	const app = createFsApi(backing)
	const vols = await Promise.all(
		Array.from({ length: 8 }, () =>
			createFsClient({
				baseUrl: 'http://rename.test',
				fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
					app.request(input as string, init)) as unknown as typeof fetch
			})
		).map(async (client) => volume(await apiStorage(client, { rootIno: backing.rootIno })))
	)
	await vols[0].mkdir('/Inbox')
	for (let i = 0; i < vols.length; i++)
		await vols[0].writeFile(`/Inbox/n${i}.md`, enc.encode(`note ${i}`))

	const results = await Promise.allSettled(
		vols.map((vol, i) => vol.rename(`/Inbox/n${i}.md`, '/Kyoto.md', { exclusive: true }))
	)
	expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
	for (const r of results) {
		if (r.status === 'rejected') expect(r.reason.message).toMatch(/^EEXIST/)
	}
	const winner = results.findIndex((r) => r.status === 'fulfilled')
	expect(dec.decode(await vols[0].readFile('/Kyoto.md'))).toBe(`note ${winner}`)
	expect((await vols[0].readdir('/Inbox')).length).toBe(vols.length - 1)
})
