/**
 * The read half of the POSIX view over a `Store` — design table A, row by row.
 *
 * The target is the EXISTING `Volume` surface: neither an agent nor just-bash
 * may be able to tell this volume from the old one, so the behaviour specs of
 * `resolve.test.ts` and `chroot.test.ts` are mirrored here against the seam.
 *
 * Rows are seeded through `commit` directly — the write side is T6.
 */

import { describe, expect, it, vi } from 'vitest'
import { type Node, type NodeId, ROOT, type Store } from './store'
import { memStore } from './store.mem'
import { FileType } from './types'
// `chroot` is written against the `Volume` interface and nothing else, so the
// old volume's one wraps this one unchanged. That it needs no new code IS the
// composition test; T18 moves it across with the rest.
import { chroot } from './volume'
import { storeVolume } from './volume.store'

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
	const node = row({ parent, name, type: 'dir', mode: 0o755 })
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

async function mklink(store: Store, parent: NodeId, name: string, target: string): Promise<NodeId> {
	const node = row({
		parent,
		name,
		type: 'symlink',
		mode: 0o777,
		link: target,
		size: BigInt(enc.encode(target).length)
	})
	await store.commit([node])
	return node.id
}

describe('resolution', () => {
	it('walks a path one segment at a time through child', async () => {
		const store = memStore()
		const notes = await mkdir(store, ROOT, 'notes')
		const trips = await mkdir(store, notes, 'trips')
		const kyoto = await mkfile(store, trips, 'kyoto.md', 'go')
		const child = vi.spyOn(store, 'child')
		const get = vi.spyOn(store, 'get')

		expect((await storeVolume(store).stat('/notes/trips/kyoto.md')).ino).toBe(kyoto)
		expect(child.mock.calls).toEqual([
			[ROOT, 'notes'],
			[notes, 'trips'],
			[trips, 'kyoto.md']
		])
		// One call per segment and nothing else: the root is the one id a walk
		// already knows, so a path that does not land on it never reads it.
		expect(get).not.toHaveBeenCalled()
	})

	it('resolves the root itself', async () => {
		const vol = storeVolume(memStore())
		const root = await vol.stat('/')
		expect(root.ino).toBe(ROOT)
		expect(root.type).toBe(FileType.Directory)
	})

	it('lands on the parent when a path ends in ..', async () => {
		const store = memStore()
		const notes = await mkdir(store, ROOT, 'notes')
		await mkdir(store, notes, 'trips')
		const vol = storeVolume(store)

		expect((await vol.stat('/notes/trips/..')).ino).toBe(notes)
		expect((await vol.stat('/notes/trips/../')).ino).toBe(notes)
		expect((await vol.stat('/notes/trips/../trips/..')).ino).toBe(notes)
		expect((await vol.stat('/notes/./trips/..')).ino).toBe(notes)
		expect((await vol.stat('/notes/..')).ino).toBe(ROOT)
		// `..` at the root is the root, as POSIX has it.
		expect((await vol.stat('/../..')).ino).toBe(ROOT)
	})

	it('throws ENOENT for a missing segment', async () => {
		const vol = storeVolume(memStore())
		await expect(vol.stat('/nope/deeper')).rejects.toThrow('ENOENT: /nope/deeper')
	})

	it('refuses to walk through a file, and keeps ENOENT when nothing is there (rule 9)', async () => {
		const store = memStore()
		const kyoto = await mkfile(store, ROOT, 'kyoto.md', 'go')
		// Rule 9 leaves "every parent a live directory" to the authority, so a
		// replica may hold a row parented on a file. Reachability from the root is
		// what makes a row visible, and POSIX cannot walk through a file — so this
		// row is not reachable, and the walk must say so rather than hand it back.
		await store.commit([row({ parent: kyoto, name: 'sub', type: 'file', size: 7n })])
		const vol = storeVolume(store)

		await expect(vol.stat('/kyoto.md/sub')).rejects.toThrow('ENOTDIR: /kyoto.md/sub')
		await expect(vol.readFile('/kyoto.md/sub')).rejects.toThrow('ENOTDIR: /kyoto.md/sub')
		expect(await vol.exists('/kyoto.md/sub')).toBe(false)
		// A name no row holds stays ENOENT, which is what the old volume answers
		// here: a consistent store must not be able to tell the two volumes apart.
		await expect(vol.stat('/kyoto.md/nope')).rejects.toThrow('ENOENT: /kyoto.md/nope')
	})

	it('lands on the target when a path goes through a symlinked directory', async () => {
		const store = memStore()
		const notes = await mkdir(store, ROOT, 'notes')
		const trips = await mkdir(store, notes, 'trips')
		await mkfile(store, trips, 'kyoto.md', 'go')
		await mklink(store, ROOT, 'alias', '/notes')
		await mklink(store, notes, 'here', 'trips') // relative targets resolve beside the link
		const vol = storeVolume(store)

		expect((await vol.stat('/alias/trips')).ino).toBe(trips)
		expect((await vol.stat('/notes/here')).ino).toBe(trips)
		expect(dec.decode(await vol.readFile('/alias/trips/kyoto.md'))).toBe('go')
	})

	it('stops a symlink loop with ELOOP', async () => {
		const store = memStore()
		await mklink(store, ROOT, 'a', '/b')
		await mklink(store, ROOT, 'b', '/a')

		await expect(storeVolume(store).stat('/a')).rejects.toThrow('ELOOP')
	})
})

describe('stat', () => {
	it('reports the row, and describes the link only under lstat', async () => {
		const store = memStore()
		const kyoto = await mkfile(store, ROOT, 'kyoto.md', 'go')
		const alias = await mklink(store, ROOT, 'alias', '/kyoto.md')
		const vol = storeVolume(store)

		const stat = await vol.stat('/alias')
		expect(stat.ino).toBe(kyoto)
		expect(stat.type).toBe(FileType.Regular)
		expect(stat.size).toBe(2n)
		expect(stat.mtimeNs).toBe(1_000n)
		// No `ctime` in the model: mtime answers for both (design #2).
		expect(stat.ctimeNs).toBe(stat.mtimeNs)
		expect(stat.contentHash).toBe(await hash(enc.encode('go')))

		const lstat = await vol.lstat('/alias')
		expect(lstat.ino).toBe(alias)
		expect(lstat.type).toBe(FileType.Symlink)
	})

	it('reports permission bits only, whatever the row carries', async () => {
		const store = memStore()
		// Rows hold whole POSIX modes — the stores mint the root as `0o040755` —
		// but `Stat` carries the kind in `type` and the old volume reports
		// permission bits here. just-bash prints this number straight out of
		// `stat`, so `/` must keep reading `0755` and not `40755`.
		await store.commit([row({ parent: ROOT, name: 'kyoto.md', type: 'file', mode: 0o100644 })])
		const vol = storeVolume(store)

		expect((await vol.stat('/')).mode).toBe(0o755)
		expect((await vol.stat('/kyoto.md')).mode).toBe(0o644)
		// setuid, setgid and sticky are permission bits, so they survive the mask.
		await store.commit([row({ parent: ROOT, name: 'run', type: 'file', mode: 0o104755 })])
		expect((await vol.stat('/run')).mode).toBe(0o4755)
	})

	it('never reads content — size is on the row', async () => {
		const store = memStore()
		await mkfile(store, ROOT, 'kyoto.md', 'go')
		const get = vi.spyOn(store.blobs, 'get')

		expect((await storeVolume(store).stat('/kyoto.md')).size).toBe(2n)
		expect(get).not.toHaveBeenCalled()
	})

	it('answers exists without throwing, dangling links included', async () => {
		const store = memStore()
		await mkfile(store, ROOT, 'kyoto.md', 'go')
		await mklink(store, ROOT, 'dangling', '/gone.md')
		const vol = storeVolume(store)

		expect(await vol.exists('/kyoto.md')).toBe(true)
		expect(await vol.exists('/')).toBe(true)
		expect(await vol.exists('/nope')).toBe(false)
		// The link itself is there; what it points at is not.
		expect(await vol.exists('/dangling')).toBe(true)
	})
})

describe('readdir', () => {
	it('returns the full listing across pages', async () => {
		const store = memStore()
		const many = await mkdir(store, ROOT, 'many')
		for (let i = 0; i < 130; i++) await mkdir(store, many, `n${String(i).padStart(3, '0')}`)
		const children = vi.spyOn(store, 'children')

		const entries = await storeVolume(store).readdir('/many')
		expect(entries).toHaveLength(130)
		expect(new Set(entries.map((e) => e.name)).size).toBe(130)
		// One page holds 128 rows, so a full listing has to follow the cursor.
		expect(children.mock.calls.length).toBeGreaterThan(1)
	})

	it('returns name, type and id per entry', async () => {
		const store = memStore()
		const notes = await mkdir(store, ROOT, 'notes')
		const kyoto = await mkfile(store, notes, 'kyoto.md', 'go')
		const trips = await mkdir(store, notes, 'trips')
		await mklink(store, notes, 'alias', '/notes')

		expect(await storeVolume(store).readdir('/notes')).toEqual([
			{ ino: expect.any(String), name: 'alias', type: FileType.Symlink },
			{ ino: kyoto, name: 'kyoto.md', type: FileType.Regular },
			{ ino: trips, name: 'trips', type: FileType.Directory }
		])
	})

	it('throws ENOTDIR on a file and ENOENT on a missing path', async () => {
		const store = memStore()
		await mkfile(store, ROOT, 'kyoto.md', 'go')
		const vol = storeVolume(store)

		await expect(vol.readdir('/kyoto.md')).rejects.toThrow('ENOTDIR: /kyoto.md')
		await expect(vol.readdir('/nope')).rejects.toThrow('ENOENT: /nope')
	})
})

describe('readFile', () => {
	it('reads the bytes the row names by hash', async () => {
		const store = memStore()
		await mkfile(store, ROOT, 'kyoto.md', 'go')
		const get = vi.spyOn(store.blobs, 'get')

		expect(dec.decode(await storeVolume(store).readFile('/kyoto.md'))).toBe('go')
		expect(get).toHaveBeenCalledWith(await hash(enc.encode('go')))
	})

	it('reads a row with no content as an empty file', async () => {
		const store = memStore()
		await store.commit([row({ parent: ROOT, name: 'empty.md', type: 'file' })])

		expect(await storeVolume(store).readFile('/empty.md')).toEqual(new Uint8Array())
	})

	it('throws ENOENT for a missing path and EISDIR for a directory', async () => {
		const store = memStore()
		await mkdir(store, ROOT, 'notes')
		const vol = storeVolume(store)

		await expect(vol.readFile('/nope.md')).rejects.toThrow('ENOENT: /nope.md')
		await expect(vol.readFile('/notes')).rejects.toThrow('EISDIR: /notes')
	})

	it('throws ENOENT when the content the row names is not here yet', async () => {
		const store = memStore()
		await store.commit([row({ parent: ROOT, name: 'lazy.md', type: 'file', content: 'deadbeef' })])

		// A lazy stub: the row is real, its bytes are not local. T9 fetches them;
		// until then the honest answer is that the content is missing, never zero bytes.
		await expect(storeVolume(store).readFile('/lazy.md')).rejects.toThrow('ENOENT')
	})
})

describe('symlinks and xattrs', () => {
	it('reads a link target from the row', async () => {
		const store = memStore()
		await mklink(store, ROOT, 'alias', '/notes')
		await mkfile(store, ROOT, 'kyoto.md', 'go')
		const vol = storeVolume(store)

		expect(await vol.readlink('/alias')).toBe('/notes')
		await expect(vol.readlink('/kyoto.md')).rejects.toThrow('EINVAL')
		await expect(vol.readlink('/nope')).rejects.toThrow('ENOENT: /nope')
	})

	it('reads xattrs from the row — no separate store', async () => {
		const store = memStore()
		const xattrs = { 'user.tag': enc.encode('trip'), 'user.mood': enc.encode('warm') }
		await store.commit([row({ parent: ROOT, name: 'kyoto.md', type: 'file', xattrs })])
		await mkfile(store, ROOT, 'plain.md', 'go')
		const vol = storeVolume(store)

		expect(await vol.getXattr('/kyoto.md', 'user.tag')).toEqual(enc.encode('trip'))
		expect(await vol.getXattr('/kyoto.md', 'user.none')).toBe(null)
		expect((await vol.listXattr('/kyoto.md')).sort()).toEqual(['user.mood', 'user.tag'])
		expect(await vol.listXattr('/plain.md')).toEqual([])
		expect(await vol.getXattr('/plain.md', 'user.tag')).toBe(null)
	})
})

describe('scan', () => {
	it('walks the subtree, directories before their contents', async () => {
		const store = memStore()
		const notes = await mkdir(store, ROOT, 'notes')
		const trips = await mkdir(store, notes, 'trips')
		await mkfile(store, trips, 'kyoto.md', 'go')
		await mkfile(store, notes, 'index.md', 'list')
		await mkdir(store, ROOT, 'other')

		const seen: string[] = []
		await storeVolume(store).scan('/notes', async (path, stat) => {
			seen.push(`${path} ${stat.type}`)
		})
		expect(seen).toEqual([
			`/notes ${FileType.Directory}`,
			`/notes/index.md ${FileType.Regular}`,
			`/notes/trips ${FileType.Directory}`,
			`/notes/trips/kyoto.md ${FileType.Regular}`
		])
	})

	it('walks from the root and throws ENOENT for a missing path', async () => {
		const store = memStore()
		await mkfile(store, ROOT, 'kyoto.md', 'go')

		const seen: string[] = []
		const vol = storeVolume(store)
		await vol.scan('/', async (path) => {
			seen.push(path)
		})
		expect(seen).toEqual(['/', '/kyoto.md'])
		await expect(vol.scan('/nope', async () => {})).rejects.toThrow('ENOENT: /nope')
	})

	it('terminates on a cyclic replica (rule 9)', async () => {
		const store = memStore()
		await mkfile(store, ROOT, 'kyoto.md', 'go')
		// Mid-sync a replica may hold rows whose parent chain loops. Here the root
		// lists itself; the walk has to bound itself rather than trust the rows.
		const cyclic: Store = {
			...store,
			async children(parent, cursor) {
				const page = await store.children(parent, cursor)
				const root = await store.get(ROOT)
				return parent === ROOT && root ? { ...page, nodes: [...page.nodes, root] } : page
			}
		}

		const seen: string[] = []
		await storeVolume(cyclic).scan('/', async (path) => {
			seen.push(path)
		})
		expect(seen).toEqual(['/', '/kyoto.md'])
	})
})

describe('chroot', () => {
	it('composes over a store volume', async () => {
		const store = memStore()
		const apps = await mkdir(store, ROOT, 'apps')
		const data = await mkdir(store, apps, 'data')
		await mkfile(store, data, 'note.txt', 'hello')
		await mkfile(store, ROOT, 'note.txt', 'outside')
		const jailed = chroot(storeVolume(store), '/apps/data')

		expect(dec.decode(await jailed.readFile('/note.txt'))).toBe('hello')
		expect((await jailed.readdir('/')).map((e) => e.name)).toEqual(['note.txt'])
		expect(await jailed.exists('/nope')).toBe(false)

		const seen: string[] = []
		await jailed.scan('/', async (path) => {
			seen.push(path)
		})
		expect(seen).toEqual(['/', '/note.txt'])
		await expect(async () => await jailed.readFile('/../note.txt')).rejects.toThrow(
			'path escapes chroot'
		)
	})
})
