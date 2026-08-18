/**
 * T15 — mounts: local-only data without ignore rules.
 *
 * Two claims, and the second only matters because of the first.
 *
 * The BOUNDARY is data. A `mount` row claims its name through the ordinary
 * `free` guard, and only a directory may be a parent — so a `/private` subtree
 * cannot exist in the synced store at all, on any replica, buggy or not. No
 * policy module holds that line; `authority.ts` refuses the rows, and the tests
 * for it here are the same shape as `authority.test.ts`: every rejection is
 * paired with a plain `memStore` taking the very same batch.
 *
 * The CROSSING is a view. Bindings are plain constructor data, read during
 * resolution the way a kernel crosses a vfsmount, and a sync engine is handed
 * one store and nothing else — so no delta, tombstone or blob request can even
 * name what is behind a mount. That is asserted by handing the bound store to
 * nobody and recording every call made on it.
 */

import { describe, expect, it, vi } from 'vitest'
import { authority } from './authority'
import { type CursorSlot, sync, versions } from './engine'
import { type Cursor, GuardError, type Node, type NodeId, ROOT, type Store } from './store'
import { memStore } from './store.mem'
import { FileType } from './types'
import { type Bindings, storeVolume } from './volume.store'

const enc = new TextEncoder()
const dec = new TextDecoder()

const hash = async (data: Uint8Array): Promise<string> =>
	Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')

const row = (over: Partial<Node> & Pick<Node, 'parent' | 'name' | 'type'>): Node => ({
	id: crypto.randomUUID(),
	mode: 0o644,
	mtimeNs: 1_000n,
	size: 0n,
	version: '1',
	...over
})

async function mkdir(store: Store, parent: NodeId, name: string): Promise<NodeId> {
	const node = row({ parent, name, type: 'dir', mode: 0o040755 })
	await store.commit([node])
	return node.id
}

async function mkfile(store: Store, parent: NodeId, name: string, text: string): Promise<NodeId> {
	const data = enc.encode(text)
	const content = await hash(data)
	await store.blobs.put(content, data)
	const node = row({ parent, name, type: 'file', content, size: BigInt(data.length) })
	await store.commit([node])
	return node.id
}

/** The mount POINT: an ordinary row, claiming its name the ordinary way. */
async function mkmount(store: Store, parent: NodeId, name: string, version = '1'): Promise<NodeId> {
	const node = row({ parent, name, type: 'mount', mode: 0o040755, version })
	await store.commit([node], [{ free: { parent, name } }])
	return node.id
}

/** One binding, as the constructor takes it: which store stands at which name, in which directory. */
const binding = (parent: NodeId, name: string, into: Store): Bindings =>
	new Map([[parent, new Map([[name, into]])]])

/** Every row a store has ever written, in feed order. */
async function rows(store: Store): Promise<Node[]> {
	const out: Node[] = []
	let cursor: Cursor | undefined
	for (;;) {
		const page = await store.since(cursor)
		out.push(...page.nodes)
		if (page.next === undefined || page.nodes.length === 0) return out
		cursor = page.next
	}
}

/** The host-local cursor slot. A variable is the whole contract (see T8). */
function cursor(): CursorSlot {
	let at: Cursor | undefined
	return {
		load: async () => at,
		save: async (saved) => {
			at = saved
		}
	}
}

/**
 * A store that records every call made on it. Nothing but the seam can reach a
 * store, so a recorder that stays silent through a whole sync IS the isolation
 * proof — there is no other way in.
 */
function recording(store: Store): { store: Store; calls: string[] } {
	const calls: string[] = []
	const note = <T>(name: string, run: () => T): T => {
		calls.push(name)
		return run()
	}
	return {
		calls,
		store: {
			get: (id) => note('get', () => store.get(id)),
			child: (parent, name) => note('child', () => store.child(parent, name)),
			children: (parent, at) => note('children', () => store.children(parent, at)),
			since: (at) => note('since', () => store.since(at)),
			commit: (writes, guards) => note('commit', () => store.commit(writes, guards)),
			blobs: {
				has: (h) => note('blobs.has', () => store.blobs.has(h)),
				get: (h) => note('blobs.get', () => store.blobs.get(h)),
				put: (h, data) => note('blobs.put', () => store.blobs.put(h, data))
			}
		}
	}
}

describe('the mount node', () => {
	it('claims its name through the ordinary free guard', async () => {
		const store = memStore()
		const mount = await mkmount(store, ROOT, 'private')

		// Nothing else can occupy the name — the same guard every create uses, and
		// the reason a replica cannot invent a `/private` of its own.
		await expect(
			store.commit(
				[row({ parent: ROOT, name: 'private', type: 'dir', mode: 0o040755 })],
				[{ free: { parent: ROOT, name: 'private' } }]
			)
		).rejects.toThrow(GuardError)
		expect((await store.child(ROOT, 'private'))?.id).toBe(mount)
	})

	it('can never have children in the synced store', async () => {
		const store = memStore()
		const mount = await mkmount(store, ROOT, 'private')
		const secret = row({ parent: mount, name: 'env', type: 'file' })

		// A plain store takes it: the invariant is the authority's, and this is the
		// difference the design leans its whole local-data story on.
		const plain = memStore()
		await mkmount(plain, ROOT, 'private')
		await expect(
			plain.commit([{ ...secret, parent: (await plain.child(ROOT, 'private'))?.id ?? ROOT }])
		).resolves.toBeUndefined()

		await expect(authority(store).commit([secret])).rejects.toThrow(GuardError)
	})

	it('cannot be the root', async () => {
		const store = memStore()
		const root = await store.get(ROOT)
		if (root === null) throw new Error('unreachable: rule 6')

		await expect(authority(store).commit([{ ...root, type: 'mount' }])).rejects.toThrow(GuardError)
	})
})

describe('crossing', () => {
	it('crosses into the bound store during resolution', async () => {
		const outer = memStore()
		const priv = memStore()
		await mkmount(outer, ROOT, 'private')
		const env = await mkfile(priv, ROOT, 'env', 'SECRET=1')
		const vol = storeVolume(outer, { bindings: binding(ROOT, 'private', priv) })
		const child = vi.spyOn(outer, 'child')

		expect(dec.decode(await vol.readFile('/private/env'))).toBe('SECRET=1')
		// The binding is read BEFORE the row lookup, so a bound name never reaches
		// the synced table at all — which is what makes shadowing work below.
		expect(child).not.toHaveBeenCalled()

		// `stat` on the mount point is the bound store's root, as a kernel mount's
		// root inode is what `stat` on a mountpoint reports.
		expect(await vol.stat('/private')).toMatchObject({ ino: ROOT, type: FileType.Directory })
		expect(await vol.readdir('/private')).toEqual([
			{ ino: env, name: 'env', type: FileType.Regular }
		])
		// `..` comes back out of it.
		expect(await vol.readdir('/private/..')).toEqual([
			{ ino: ROOT, name: 'private', type: FileType.Directory }
		])
	})

	it('keeps every operation inside the mount in the bound store', async () => {
		const outer = memStore()
		const priv = memStore()
		await mkmount(outer, ROOT, 'private')
		const vol = storeVolume(outer, { bindings: binding(ROOT, 'private', priv) })
		const before = await rows(outer)

		await vol.mkdir('/private/notes')
		await vol.writeFile('/private/notes/a.md', enc.encode('hi'))

		// Not one row, and not one byte, entered the synced store.
		expect(await rows(outer)).toEqual(before)
		expect(await outer.blobs.has(await hash(enc.encode('hi')))).toBe(false)
		expect(await priv.blobs.has(await hash(enc.encode('hi')))).toBe(true)
		expect(dec.decode(await vol.readFile('/private/notes/a.md'))).toBe('hi')

		const seen: string[] = []
		await vol.scan('/', async (path) => {
			seen.push(path)
		})
		expect(seen).toEqual(['/', '/private', '/private/notes', '/private/notes/a.md'])
	})

	it('reads an unbound mount as an empty read-only directory', async () => {
		const outer = memStore()
		const mount = await mkmount(outer, ROOT, 'private')
		const vol = storeVolume(outer)

		expect(await vol.stat('/private')).toMatchObject({ ino: mount, type: FileType.Directory })
		expect(await vol.readdir('/private')).toEqual([])
		// The name is taken everywhere, bound or not: that is what announcing buys.
		expect(await vol.readdir('/')).toEqual([
			{ ino: mount, name: 'private', type: FileType.Directory }
		])
		await expect(vol.writeFile('/private/env', enc.encode('no'))).rejects.toThrow(/^EROFS/)
		await expect(vol.mkdir('/private/notes')).rejects.toThrow(/^EROFS/)
		await expect(vol.rename('/private', '/private/self')).rejects.toThrow(/^EROFS/)
	})

	it('falls back to copy-then-remove when a rename crosses stores', async () => {
		const outer = memStore()
		const priv = memStore()
		await mkmount(outer, ROOT, 'private')
		const notes = await mkdir(outer, ROOT, 'notes')
		const kyoto = await mkfile(outer, notes, 'kyoto.md', 'go')
		const vol = storeVolume(outer, { bindings: binding(ROOT, 'private', priv) })

		await vol.rename('/notes', '/private/notes')

		// The synced store lost the whole subtree...
		expect(await outer.child(ROOT, 'notes')).toBeNull()
		expect((await outer.get(notes))?.deleted).toBe(true)
		expect((await outer.get(kyoto))?.deleted).toBe(true)
		// ...and the bound one gained it under NEW ids. A rename moves one row and
		// keeps its id; nothing that crosses a store can, which is what EXDEV says.
		const there = await priv.child(ROOT, 'notes')
		expect(there?.id).not.toBe(notes)
		expect((await priv.child(there?.id ?? ROOT, 'kyoto.md'))?.id).not.toBe(kyoto)
		// The bytes crossed too: a hash names nothing in a store that lacks them.
		expect(await priv.blobs.has(await hash(enc.encode('go')))).toBe(true)
		expect(dec.decode(await vol.readFile('/private/notes/kyoto.md'))).toBe('go')
	})

	it('refuses a cross-store rename onto a directory that still holds entries', async () => {
		const outer = memStore()
		const priv = memStore()
		await mkmount(outer, ROOT, 'private')
		const vol = storeVolume(outer, { bindings: binding(ROOT, 'private', priv) })
		await vol.mkdir('/notes')
		await vol.writeFile('/notes/kyoto.md', enc.encode('go'))
		await vol.mkdir('/private/notes')
		await vol.writeFile('/private/notes/other.md', enc.encode('keep'))

		// Crossing a mount does not change what a rename MEANS. The primitive raises
		// EXDEV before it ever reads the destination, so `mv` asks the same questions
		// itself — or a copy would merge into a directory the same rename inside one
		// store refuses, and then remove the source.
		await expect(vol.rename('/notes', '/private/notes')).rejects.toThrow(/^ENOTEMPTY/)

		expect(dec.decode(await vol.readFile('/notes/kyoto.md'))).toBe('go')
		expect(await vol.exists('/private/notes/kyoto.md')).toBe(false)
		expect(dec.decode(await vol.readFile('/private/notes/other.md'))).toBe('keep')
	})

	it('refuses a cross-store rename that would replace a directory with a file', async () => {
		const outer = memStore()
		const priv = memStore()
		await mkmount(outer, ROOT, 'private')
		const vol = storeVolume(outer, { bindings: binding(ROOT, 'private', priv) })
		await vol.writeFile('/kyoto.md', enc.encode('go'))
		await vol.mkdir('/private/kyoto.md')

		await expect(vol.rename('/kyoto.md', '/private/kyoto.md')).rejects.toThrow(/^EISDIR/)

		expect(dec.decode(await vol.readFile('/kyoto.md'))).toBe('go')
		expect((await vol.stat('/private/kyoto.md')).type).toBe(FileType.Directory)
	})

	it('keeps the guards of both endpoint walks inside one mount', async () => {
		const outer = memStore()
		const priv = memStore()
		await mkmount(outer, ROOT, 'private')
		const vol = storeVolume(outer, { bindings: binding(ROOT, 'private', priv) })
		await vol.mkdir('/private/a')
		await vol.mkdir('/private/b')
		await vol.writeFile('/private/a/old', enc.encode('old'))
		await vol.writeFile('/private/b/new', enc.encode('keep'))
		// Relative, so the walk stays inside the mount: an absolute target would
		// start again at the global root, whichever store the link lives in.
		await vol.symlink('a', '/private/link')
		await vol.symlink('b', '/private/retarget')
		const old = await priv.child((await priv.child(ROOT, 'a'))?.id ?? ROOT, 'old')
		let raced = false

		// Re-point the shared link between the two endpoint walks. The rows the FIRST
		// walk read are what catches it, and both walks re-enter the same bound store
		// — so a crossing that dropped the path walked so far would lose them and
		// commit a move the path no longer names.
		const racing: Store = {
			...priv,
			async child(parent, name) {
				const node = await priv.child(parent, name)
				if (!raced && node?.id === old?.id) {
					raced = true
					await vol.cp('/private/retarget', '/private/link')
				}
				return node
			}
		}
		const racy = storeVolume(outer, { bindings: binding(ROOT, 'private', racing) })

		await expect(racy.rename('/private/link/old', '/private/link/new')).rejects.toThrow(/^ENOENT/)

		expect(raced).toBe(true)
		expect(await vol.readlink('/private/link')).toBe('b')
		expect(dec.decode(await vol.readFile('/private/a/old'))).toBe('old')
		expect(dec.decode(await vol.readFile('/private/b/new'))).toBe('keep')
	})
})

describe('silent bindings', () => {
	it('shadows the synced rows under the name, and gives them back intact', async () => {
		const outer = memStore()
		const priv = memStore()
		const special = await mkdir(outer, ROOT, '.special')
		await mkfile(outer, special, 'shared.md', 'everyone')
		const mine = await mkfile(priv, ROOT, 'mine.md', 'only me')
		const bindings = binding(ROOT, '.special', priv)
		const vol = storeVolume(outer, { bindings })
		const before = await rows(outer)
		const fetched = vi.spyOn(outer.blobs, 'get')

		expect(dec.decode(await vol.readFile('/.special/mine.md'))).toBe('only me')
		// The synced rows are still there, and unreachable — a kernel mount over a
		// non-empty directory.
		expect(await vol.exists('/.special/shared.md')).toBe(false)
		expect(await vol.readdir('/.special')).toEqual([
			{ ino: mine, name: 'mine.md', type: FileType.Regular }
		])
		expect(await vol.readdir('/')).toEqual([
			{ ino: ROOT, name: '.special', type: FileType.Directory }
		])
		// Shadowed blobs are never fetched: the row is never resolved to.
		expect(fetched).not.toHaveBeenCalled()
		// And nothing about the binding was ever written down.
		expect(await rows(outer)).toEqual(before)

		// Removing the binding reveals the shared data, intact.
		bindings.get(ROOT)?.delete('.special')
		expect(dec.decode(await vol.readFile('/.special/shared.md'))).toBe('everyone')
	})
})

describe('isolation', () => {
	it('never offers the mounted store to a sync engine', async () => {
		const outer = memStore()
		const hub = memStore()
		const priv = recording(memStore())
		const mint = versions('a')
		const vol = storeVolume(outer, {
			bindings: binding(ROOT, 'private', priv.store),
			mintVersion: mint
		})
		await mkmount(outer, ROOT, 'private', mint())

		await vol.writeFile('/private/env', enc.encode('SECRET'))
		await vol.writeFile('/notes.md', enc.encode('shared'))
		priv.calls.length = 0

		await sync(outer, hub, { replica: 'a', pull: cursor(), push: cursor() })

		// The engine holds one store. It cannot name what it was never handed.
		expect(priv.calls).toEqual([])
		expect(
			(await rows(hub))
				.filter((r) => r.id !== ROOT)
				.map((r) => `${r.name}:${r.type}`)
				.sort()
		).toEqual(['notes.md:file', 'private:mount'])
		expect(await hub.blobs.has(await hash(enc.encode('shared')))).toBe(true)
		expect(await hub.blobs.has(await hash(enc.encode('SECRET')))).toBe(false)
	})

	it('resolves one synced symlink to different bytes on two replicas', async () => {
		const here = memStore()
		const there = memStore()
		const privHere = memStore()
		const privThere = memStore()
		await mkfile(privHere, ROOT, 'env', 'API_KEY=here')
		await mkfile(privThere, ROOT, 'env', 'API_KEY=there')

		const mint = versions('a')
		const volHere = storeVolume(here, {
			bindings: binding(ROOT, 'private', privHere),
			mintVersion: mint
		})
		await mkmount(here, ROOT, 'private', mint())
		// The tree shape syncs; the content never does — the Unix `/etc` convention,
		// and the clean shape for a `.env`.
		await volHere.symlink('/private/env', '/config')

		await sync(here, there, { replica: 'a', pull: cursor(), push: cursor() })
		const volThere = storeVolume(there, {
			bindings: binding(ROOT, 'private', privThere),
			mintVersion: versions('b')
		})

		expect(dec.decode(await volHere.readFile('/config'))).toBe('API_KEY=here')
		expect(dec.decode(await volThere.readFile('/config'))).toBe('API_KEY=there')
		expect(await there.blobs.has(await hash(enc.encode('API_KEY=here')))).toBe(false)
	})
})
