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
import { type Volume, WATCH_BURST_MS } from './volume'
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

/** For what must arrive. The deadline is loose: nothing here asserts latency. */
async function waitFor(assertion: () => void): Promise<void> {
	const deadline = Date.now() + WATCH_BURST_MS * 40
	let last: unknown
	for (;;) {
		try {
			return assertion()
		} catch (e) {
			last = e
			if (Date.now() > deadline) throw last
			await new Promise((resolve) => setTimeout(resolve, WATCH_BURST_MS / 5))
		}
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

/**
 * `mv` means one thing, and a mount must not change what it means.
 *
 * A rename inside one store MOVES a row. A rename that crosses one cannot, and
 * has to re-create it — so the two are different code, and every field the second
 * forgets, and every rule about the destination it reads differently, is a bug.
 * They can disagree in more ways than a list of cases would ever cover, and each
 * one found by hand is one more patch. So this does not list them: it runs the
 * SAME story through both and holds the crossing to one of two answers.
 *
 * It did what the one-store rename did, or it refused with `EXDEV` and left
 * everything exactly as it was. There is no third answer. Crossing a mount
 * narrows what `mv` will ATTEMPT — the kernel refuses every cross-device rename,
 * and this refuses the ones it cannot finish whole — and never changes what `mv`
 * MEANS where it does go through.
 */
describe('a rename across a mount is still a rename', () => {
	/**
	 * A subtree with something of everything a row can carry, seeded as ROWS so
	 * every field is exact. Built through the volume it would take its times from
	 * the clock, and the comparison would then be of two runs rather than of two
	 * renames.
	 */
	async function seed(store: Store, parent: NodeId, name: string): Promise<void> {
		const src = row({
			parent,
			name,
			type: 'dir',
			mode: 0o040755,
			mtimeNs: 1_000n,
			xattrs: { 'user.tag': enc.encode('root') }
		})
		const deep = row({
			parent: src.id,
			name: 'deep',
			type: 'dir',
			mode: 0o040750,
			mtimeNs: 2_000n,
			xattrs: { 'user.tag': enc.encode('folder') }
		})
		const data = enc.encode('go')
		const content = await hash(data)
		await store.blobs.put(content, data)
		const kyoto = row({
			parent: deep.id,
			name: 'kyoto.md',
			type: 'file',
			mode: 0o100600,
			mtimeNs: 3_000n,
			size: BigInt(data.length),
			content,
			xattrs: { 'user.tag': enc.encode('trip') }
		})
		const empty = row({
			parent: src.id,
			name: 'empty',
			type: 'dir',
			mode: 0o040700,
			mtimeNs: 4_000n
		})
		const link = row({
			parent: src.id,
			name: 'link',
			type: 'symlink',
			mode: 0o120777,
			mtimeNs: 5_000n,
			size: BigInt('deep/kyoto.md'.length),
			link: 'deep/kyoto.md'
		})
		await store.commit([src, deep, kyoto, empty, link])
	}

	/** Everything a volume can say about a subtree, apart from the ids. */
	async function tree(vol: Volume, root: string): Promise<Record<string, unknown>> {
		const out: Record<string, unknown> = {}
		await vol.scan(root, async (path, stat) => {
			const xattrs: Record<string, string> = {}
			for (const name of await vol.listXattr(path).catch(() => []))
				xattrs[name] = dec.decode((await vol.getXattr(path, name)) ?? new Uint8Array())
			out[path.slice(root.length) || '/'] = {
				type: stat.type,
				mode: stat.mode,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				content: stat.contentHash,
				link: stat.type === FileType.Symlink ? await vol.readlink(path) : undefined,
				xattrs
			}
		})
		return out
	}

	/** What else is standing in the destination's directory, and still is. */
	const beside = async (vol: Volume, path: string): Promise<string[]> =>
		(await vol.readdir(path)).map((entry) => `${entry.name}:${entry.type}`).sort()

	/** Everything there is to see, from the three places a rename can change. */
	const state = async (
		vol: Volume,
		from: string,
		dest: string,
		box: string
	): Promise<Record<string, unknown>> => ({
		moved: await tree(vol, dest).catch(() => null),
		beside: await beside(vol, box),
		source: await tree(vol, from).catch(() => null)
	})

	/** What the rename did: what it refused with, and the state it left. */
	async function outcome(
		vol: Volume,
		from: string,
		dest: string,
		box: string
	): Promise<Record<string, unknown>> {
		let refused: string | undefined
		try {
			await vol.rename(from, dest)
		} catch (e) {
			refused = (e as Error).message.split(':')[0]
		}
		return { refused, ...(await state(vol, from, dest, box)) }
	}

	/** One story, run inside a single store and then across a mount. */
	async function both(
		from: string,
		set?: (vol: Volume, dest: string) => Promise<void>
	): Promise<{
		here: Record<string, unknown>
		untouched: Record<string, unknown>
		across: Record<string, unknown>
	}> {
		const one = memStore()
		const here = storeVolume(one)
		await here.mkdir('/box')
		await seed(one, ROOT, 'src')

		const outer = memStore()
		await mkmount(outer, ROOT, 'private')
		const across = storeVolume(outer, { bindings: binding(ROOT, 'private', memStore()) })
		await across.mkdir('/private/box')
		await seed(outer, ROOT, 'src')

		await set?.(here, '/box/dest')
		await set?.(across, '/private/box/dest')

		return {
			here: await outcome(here, from, '/box/dest', '/box'),
			// What a refusal has to leave behind, read before anything is attempted.
			untouched: await state(across, from, '/private/box/dest', '/private/box'),
			across: await outcome(across, from, '/private/box/dest', '/private/box')
		}
	}

	/** Times set by hand for the same reason `seed` does it: the clock is not a fixture. */
	const stamped = (vol: Volume, path: string, at: bigint): Promise<void> => vol.utimes(path, at)

	/**
	 * Every kind of thing that can be moved, against every kind of thing it can be
	 * moved onto. A PRODUCT, not a list: the ways these two paths can disagree are
	 * combinations, and a list only ever holds the ones somebody already found.
	 */
	const sources = [
		{ kind: 'a directory', from: '/src' },
		{ kind: 'a file', from: '/src/deep/kyoto.md' },
		{ kind: 'a symlink', from: '/src/link' }
	]

	const destinations: { kind: string; set?: (vol: Volume, dest: string) => Promise<void> }[] = [
		{ kind: 'a free name' },
		{
			kind: 'a file',
			set: async (vol, dest) => {
				await vol.writeFile(dest, enc.encode('gone'))
				await stamped(vol, dest, 9_000n)
			}
		},
		{
			kind: 'a symlink',
			set: async (vol, dest) => {
				await vol.writeFile(`${dest}.target`, enc.encode('keep'))
				await stamped(vol, `${dest}.target`, 9_000n)
				await vol.symlink('dest.target', dest)
			}
		},
		{
			kind: 'an empty directory',
			set: async (vol, dest) => {
				await vol.mkdir(dest)
				await stamped(vol, dest, 9_000n)
			}
		},
		{
			kind: 'a directory that still holds entries',
			set: async (vol, dest) => {
				await vol.mkdir(dest)
				await vol.writeFile(`${dest}/other.md`, enc.encode('keep'))
				await stamped(vol, `${dest}/other.md`, 9_000n)
				await stamped(vol, dest, 9_000n)
			}
		}
	]

	for (const source of sources)
		for (const dest of destinations)
			it(`moves ${source.kind} onto ${dest.kind}`, async () => {
				const { here, untouched, across } = await both(source.from, dest.set)
				if (across.refused === 'EXDEV') expect(across).toEqual({ refused: 'EXDEV', ...untouched })
				else expect(across).toEqual(here)
			})

	// The three refusals, named. Each is a move that cannot be made WHOLE, and half
	// a move is worse than none — so `EXDEV` reaches the caller, exactly as it does
	// for every cross-device rename the kernel is asked for.

	it('refuses to move a mount point into another store', async () => {
		const outer = memStore()
		const priv = memStore()
		const other = memStore()
		await mkmount(outer, ROOT, 'private')
		await mkmount(outer, ROOT, 'other')
		const vol = storeVolume(outer, {
			bindings: new Map([
				[
					ROOT,
					new Map([
						['private', priv],
						['other', other]
					])
				]
			])
		})
		await vol.writeFile('/private/env', enc.encode('SECRET'))

		// `/private` names the mount POINT, and resolution crosses it — so what a
		// move would find there is the local store's root, not a row to move.
		await expect(vol.rename('/private', '/other/moved')).rejects.toThrow(/^EXDEV/)

		expect((await outer.child(ROOT, 'private'))?.type).toBe('mount')
		expect(dec.decode(await vol.readFile('/private/env'))).toBe('SECRET')
		expect(await vol.readdir('/other')).toEqual([])
	})

	it('refuses to move a directory into a store mounted beneath it', async () => {
		const outer = memStore()
		const priv = memStore()
		const src = await mkdir(outer, ROOT, 'src')
		await mkmount(outer, src, 'private')
		const vol = storeVolume(outer, { bindings: binding(src, 'private', priv) })
		await vol.writeFile('/src/private/env', enc.encode('SECRET'))

		// The route to the local store is the very row this move would tombstone,
		// which would strand what it had just written there.
		await expect(vol.rename('/src', '/src/private/moved')).rejects.toThrow(/^EXDEV/)

		expect(await vol.exists('/src')).toBe(true)
		expect(await vol.exists('/src/private/moved')).toBe(false)
		expect(dec.decode(await vol.readFile('/src/private/env'))).toBe('SECRET')
	})

	it('refuses to replace a destination that already exists', async () => {
		const outer = memStore()
		const priv = memStore()
		await mkmount(outer, ROOT, 'private')
		const vol = storeVolume(outer, { bindings: binding(ROOT, 'private', priv) })
		await vol.writeFile('/kyoto.md', enc.encode('go'))
		await vol.writeFile('/private/kyoto.md', enc.encode('keep'))

		// Two stores are two commits, so there is no moment where the name holds one
		// or the other. Inside one store the same rename still replaces, atomically.
		await expect(vol.rename('/kyoto.md', '/private/kyoto.md')).rejects.toThrow(/^EXDEV/)

		expect(dec.decode(await vol.readFile('/kyoto.md'))).toBe('go')
		expect(dec.decode(await vol.readFile('/private/kyoto.md'))).toBe('keep')
	})

	// The differential above pins the two to each other; this pins them to
	// something, so they cannot agree by both being empty.
	it('carries the whole row, not a list of its fields', async () => {
		const outer = memStore()
		await mkmount(outer, ROOT, 'private')
		const vol = storeVolume(outer, { bindings: binding(ROOT, 'private', memStore()) })
		await seed(outer, ROOT, 'src')

		await vol.rename('/src', '/private/dest')

		expect(await tree(vol, '/private/dest')).toEqual({
			'/': {
				type: FileType.Directory,
				mode: 0o755,
				size: 0n,
				mtimeNs: 1_000n,
				content: undefined,
				link: undefined,
				xattrs: { 'user.tag': 'root' }
			},
			'/deep': {
				type: FileType.Directory,
				mode: 0o750,
				size: 0n,
				mtimeNs: 2_000n,
				content: undefined,
				link: undefined,
				xattrs: { 'user.tag': 'folder' }
			},
			'/deep/kyoto.md': {
				type: FileType.Regular,
				mode: 0o600,
				size: 2n,
				mtimeNs: 3_000n,
				content: await hash(enc.encode('go')),
				link: undefined,
				xattrs: { 'user.tag': 'trip' }
			},
			'/empty': {
				type: FileType.Directory,
				mode: 0o700,
				size: 0n,
				mtimeNs: 4_000n,
				content: undefined,
				link: undefined,
				xattrs: {}
			},
			'/link': {
				type: FileType.Symlink,
				mode: 0o777,
				size: 13n,
				mtimeNs: 5_000n,
				content: undefined,
				link: 'deep/kyoto.md',
				xattrs: { 'user.tag': 'trip' }
			}
		})
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

/**
 * A watch matches rows by id, and an id means nothing outside the store that
 * minted it — so every id a watch remembers is kept with its store. What it must
 * NOT do is pick one store up front and drop everything else: which store a path
 * lives in is a question only a read of the tree answers, and a watch is armed
 * before it may read one.
 */
describe('watching across a mount', () => {
	it('binds a path inside a mount that does not exist yet', async () => {
		const outer = memStore()
		const priv = memStore()
		await mkmount(outer, ROOT, 'private')
		const vol = storeVolume(outer, { bindings: binding(ROOT, 'private', priv) })

		// Neither the path nor its parent resolves, so nothing about the tree can say
		// which store this will live in. Only the mount point does.
		let fired = 0
		const off = await vol.watch('/private/state/app.json', () => fired++)

		await vol.mkdir('/private/state')
		await vol.writeFile('/private/state/app.json', enc.encode('{}'))

		await waitFor(() => expect(fired).toBeGreaterThan(0))
		off()
	})

	it('wakes a recursive watch inside a mount that does not exist yet', async () => {
		const outer = memStore()
		const priv = memStore()
		await mkmount(outer, ROOT, 'private')
		const vol = storeVolume(outer, { bindings: binding(ROOT, 'private', priv) })

		// Deep enough that the parent does not resolve either — with `/private/state`
		// already there, the parent walk alone would have found the store.
		let fired = 0
		const off = await vol.watch('/private/state/apps', () => fired++, { recursive: true })

		await vol.mkdir('/private/state/apps', { recursive: true })
		await vol.writeFile('/private/state/apps/one.json', enc.encode('{}'))

		await waitFor(() => expect(fired).toBeGreaterThan(0))
		off()
	})

	it("does not wake for the same name under another store's root", async () => {
		const outer = memStore()
		const priv = memStore()
		await mkmount(outer, ROOT, 'private')
		const vol = storeVolume(outer, { bindings: binding(ROOT, 'private', priv) })

		// The watched path's parent IS the bound store's root, and every store spells
		// its root `ROOT` — so a row at the same name under the OUTER root carries the
		// very same `(parent, name)`. Only the store tells them apart.
		let fired = 0
		const off = await vol.watch('/private/app.json', () => fired++)

		await vol.writeFile('/app.json', enc.encode('{}'))
		await new Promise((resolve) => setTimeout(resolve, WATCH_BURST_MS * 4))
		expect(fired).toBe(0)

		// ...and the real one still wakes it.
		await vol.writeFile('/private/app.json', enc.encode('{}'))
		await waitFor(() => expect(fired).toBe(1))
		off()
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
