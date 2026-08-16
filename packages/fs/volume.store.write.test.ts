/**
 * The write half of the POSIX view over a `Store` — design table A, plus the one
 * rule that is not cosmetics: every create, delete and rename stamps the PARENT
 * directory in the SAME commit. That bumps the parent's version, which is what
 * lets a batch that enumerated a directory (`rm -r`) guard against a concurrent
 * create it never saw.
 *
 * The intents of `exclusive.test.ts`, `displace.test.ts`, `append-order.test.ts`
 * and `listdir-vanish.test.ts` are ported here. The old volume owed those
 * guarantees to backend capabilities — `atomicCreate`, `atomicMove`, a per-inode
 * write chain. This one owes them to guarded commits and nothing else.
 */

import { describe, expect, it, vi } from 'vitest'
import { type Cursor, type Node, ROOT, type Store } from './store'
import { memStore } from './store.mem'
import { FileType } from './types'
import type { Volume } from './volume'
import { storeVolume } from './volume.store'

const enc = new TextEncoder()
const dec = new TextDecoder()

const hash = async (data: Uint8Array): Promise<string> =>
	Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')

const read = async (vol: Volume, path: string): Promise<string> =>
	dec.decode(await vol.readFile(path))

/** The row a path names, straight out of the store — modes and versions unmasked. */
async function rowAt(store: Store, path: string): Promise<Node> {
	let node: Node | null = await store.get(ROOT)
	for (const name of path.split('/').filter((s) => s !== '')) {
		node = await store.child(node?.id ?? ROOT, name)
		if (node === null) throw new Error(`no row at ${path}`)
	}
	if (node === null) throw new Error(`no row at ${path}`)
	return node
}

/** Where the feed stands now, so a later `since` reports only what came after. */
async function tip(store: Store): Promise<Cursor> {
	let cursor: Cursor | undefined
	for (;;) {
		const page = await store.since(cursor)
		if (page.next === undefined) throw new Error('since must always hand a cursor back')
		cursor = page.next
		if (page.nodes.length === 0) return cursor
	}
}

/** Everything the feed holds past `cursor`. */
async function feed(store: Store, cursor: Cursor): Promise<Node[]> {
	const nodes: Node[] = []
	let at: Cursor | undefined = cursor
	for (;;) {
		const page: { nodes: Node[]; next?: Cursor } = await store.since(at)
		nodes.push(...page.nodes)
		at = page.next
		if (page.nodes.length === 0) return nodes
	}
}

describe('writeFile: a create claims a name', () => {
	it('makes the content durable before it commits the row that names it (rule 10)', async () => {
		const store = memStore()
		const trace: string[] = []
		const traced: Store = {
			...store,
			commit: (writes, guards) => {
				trace.push('commit')
				return store.commit(writes, guards)
			},
			blobs: {
				...store.blobs,
				put: (h, data) => {
					trace.push('blobs.put')
					return store.blobs.put(h, data)
				}
			}
		}

		await storeVolume(traced).writeFile('/kyoto.md', enc.encode('go'))

		// A crash between them may leave an orphan blob. The other order would leave
		// a committed row whose bytes were never stored.
		expect(trace).toEqual(['blobs.put', 'commit'])
		expect((await rowAt(store, '/kyoto.md')).content).toBe(await hash(enc.encode('go')))
	})

	it('stores the bytes passed when the write starts', async () => {
		const vol = storeVolume(memStore())
		const data = enc.encode('hello')

		const write = vol.writeFile('/kyoto.md', data)
		data.fill(0)
		await write

		expect(await read(vol, '/kyoto.md')).toBe('hello')
	})

	it('claims the name with a free guard, and holds the parent it stamps', async () => {
		const store = memStore()
		const root = await store.get(ROOT)
		const commit = vi.spyOn(store, 'commit')

		await storeVolume(store).writeFile('/kyoto.md', enc.encode('go'))

		expect(commit.mock.calls[0]?.[1]).toEqual([
			{ free: { parent: ROOT, name: 'kyoto.md' } },
			{ version: { id: ROOT, is: root?.version } }
		])
	})

	it('gives the name to exactly one of N concurrent claimants', async () => {
		const vol = storeVolume(memStore())
		// All 20 start before any of them finishes: the interleaving a TOCTOU loses to.
		const results = await Promise.allSettled(
			Array.from({ length: 20 }, (_, i) =>
				vol.writeFile('/kyoto.md', enc.encode(`writer ${i}`), { exclusive: true })
			)
		)

		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
		const winner = results.findIndex((r) => r.status === 'fulfilled')
		expect(await read(vol, '/kyoto.md')).toBe(`writer ${winner}`)
		for (const result of results)
			if (result.status === 'rejected') expect(result.reason.message).toMatch(/^EEXIST/)
	})

	it('lets the loser of a claim read the winner back at once, never a prefix', async () => {
		// The loser's catch fires the instant ITS write rejects, which is independent
		// of whether the winner's write has finished. Awaiting both first would never
		// see the window.
		const vol = storeVolume(memStore())
		let loser: string | undefined
		const claim = (body: string) =>
			vol.writeFile('/id', enc.encode(body), { exclusive: true }).catch(async () => {
				loser = await read(vol, '/id')
			})

		await Promise.all([claim('a'), claim('b')])
		expect(loser).toMatch(/^[ab]$/)
	})

	it('is create-OR-overwrite without the flag, so two racers both survive', async () => {
		const vol = storeVolume(memStore())
		const results = await Promise.allSettled([
			vol.writeFile('/app.json', enc.encode('a')),
			vol.writeFile('/app.json', enc.encode('b'))
		])

		// One wins the name and the other becomes an update against it. Either order
		// is fine; a caller who never asked for a claim seeing EEXIST is not.
		for (const result of results) expect(result.status).toBe('fulfilled')
		expect(['a', 'b']).toContain(await read(vol, '/app.json'))
	})

	it('refuses a name a dangling symlink holds, rather than stranding the bytes in it', async () => {
		const vol = storeVolume(memStore())
		await vol.symlink('/missing-target', '/link')

		await expect(vol.writeFile('/link', enc.encode('hello'))).rejects.toThrow(/^EEXIST/)
		expect((await vol.lstat('/link')).type).toBe(FileType.Symlink)
	})

	it('lands on the target through a live symlink, and leaves the link a link', async () => {
		const vol = storeVolume(memStore())
		await vol.writeFile('/target.txt', enc.encode('original'))
		await vol.symlink('/target.txt', '/link')

		await vol.writeFile('/link', enc.encode('via the link'))
		expect(await read(vol, '/target.txt')).toBe('via the link')
		expect((await vol.lstat('/link')).type).toBe(FileType.Symlink)
	})

	it('mints a file row with the file type bits and 0644', async () => {
		const store = memStore()
		await storeVolume(store).writeFile('/kyoto.md', enc.encode('go'))

		const row = await rowAt(store, '/kyoto.md')
		expect(row.mode).toBe(0o100644)
		expect(row.type).toBe('file')
		expect(row.size).toBe(2n)
		expect((await storeVolume(store).stat('/kyoto.md')).mode).toBe(0o644)
	})

	it('refuses to invent a file for an update, and conjures no folders on the way', async () => {
		const vol = storeVolume(memStore())

		await expect(
			vol.writeFile('/trips/kyoto.md', enc.encode('edited'), { update: true })
		).rejects.toThrow(/^ENOENT/)
		expect(await vol.exists('/trips')).toBe(false)
	})

	it('throws ENOENT when a parent directory is missing', async () => {
		const vol = storeVolume(memStore())
		await expect(vol.writeFile('/trips/kyoto.md', enc.encode('x'))).rejects.toThrow(/^ENOENT/)
	})

	it('throws EISDIR on a directory, with or without the flag', async () => {
		const vol = storeVolume(memStore())
		await vol.mkdir('/trips')

		await expect(vol.writeFile('/trips', enc.encode('x'))).rejects.toThrow(/^EISDIR/)
		await expect(vol.writeFile('/trips', enc.encode('x'), { exclusive: true })).rejects.toThrow(
			/^EEXIST/
		)
	})
})

describe('writeFile: an overwrite replaces the row', () => {
	it('guards on the version it read', async () => {
		const store = memStore()
		const vol = storeVolume(store)
		await vol.writeFile('/kyoto.md', enc.encode('first'))
		const before = await rowAt(store, '/kyoto.md')
		const commit = vi.spyOn(store, 'commit')

		await vol.writeFile('/kyoto.md', enc.encode('second'))

		expect(commit.mock.calls[0]?.[1]).toEqual([{ version: { id: before.id, is: before.version } }])
		expect(await read(vol, '/kyoto.md')).toBe('second')
	})

	it('keeps the id, the mode and the xattrs, and moves mtime', async () => {
		const store = memStore()
		const vol = storeVolume(store)
		await vol.writeFile('/kyoto.md', enc.encode('first'))
		await vol.chmod('/kyoto.md', 0o600)
		await vol.setXattr('/kyoto.md', 'user.tag', enc.encode('trip'))
		const before = await rowAt(store, '/kyoto.md')

		await vol.writeFile('/kyoto.md', enc.encode('a much longer second body'))

		const after = await rowAt(store, '/kyoto.md')
		expect(after.id).toBe(before.id) // an id is minted once, never rebound
		expect(after.mode).toBe(0o100600)
		expect(after.xattrs?.['user.tag']).toEqual(enc.encode('trip'))
		expect(after.size).toBe(25n)
		expect(after.version).not.toBe(before.version)
	})

	it('truncates: the row names the new bytes and nothing of the old ones', async () => {
		const store = memStore()
		const vol = storeVolume(store)
		await vol.writeFile('/kyoto.md', enc.encode('a long first body'))

		await vol.writeFile('/kyoto.md', enc.encode('hi'))

		expect(await read(vol, '/kyoto.md')).toBe('hi')
		expect((await rowAt(store, '/kyoto.md')).size).toBe(2n)
	})

	it('fails an update whose file was removed while the bytes were in flight', async () => {
		// The gap `update: true` cannot close by resolving alone: the path resolved,
		// and the file went away before the row committed. Reporting success there is
		// how an editor clears its unsaved marker over a note that is gone.
		const vol = storeVolume(memStore())
		await vol.writeFile('/kyoto.md', enc.encode('first'))
		const write = vol.writeFile('/kyoto.md', enc.encode('second'), { update: true })
		await vol.rm('/kyoto.md')

		await expect(write).rejects.toThrow(/^ENOENT/)
		expect(await vol.exists('/kyoto.md')).toBe(false)
	})

	it('does not stamp the parent — content is not structure', async () => {
		const store = memStore()
		const vol = storeVolume(store)
		await vol.writeFile('/kyoto.md', enc.encode('first'))
		const root = await store.get(ROOT)

		await vol.writeFile('/kyoto.md', enc.encode('second'))

		expect((await store.get(ROOT))?.version).toBe(root?.version)
	})
})

describe('the parent stamp', () => {
	it('rides in the same commit as a create', async () => {
		const store = memStore()
		const vol = storeVolume(store)
		await vol.mkdir('/notes')
		const before = await rowAt(store, '/notes')
		const commit = vi.spyOn(store, 'commit')

		await vol.writeFile('/notes/kyoto.md', enc.encode('go'))

		const [writes] = commit.mock.calls[0] ?? []
		const parent = writes?.find((w) => w.id === before.id)
		expect(writes).toHaveLength(2)
		expect(parent?.version).not.toBe(before.version)
		expect(parent?.mtimeNs).toBeGreaterThanOrEqual(before.mtimeNs)
		expect((await rowAt(store, '/notes')).version).toBe(parent?.version)
	})

	it('never brings back a directory that was removed under a create', async () => {
		// A stamp writes the WHOLE parent row back, so a row read before a removal
		// would restore a directory that `rm -r` already reported gone. The parent
		// is guarded for that reason, not only stamped.
		const store = memStore()
		const vol = storeVolume(store)
		const other = storeVolume(store)
		await vol.mkdir('/notes')
		const notes = await rowAt(store, '/notes')

		let raced = false
		const racy: Store = {
			...store,
			async commit(writes, guards) {
				// The create resolved `/notes`; the removal lands before it commits.
				if (!raced && writes.some((w) => w.parent === notes.id && !w.deleted)) {
					raced = true
					await other.rm('/notes', { recursive: true })
				}
				return store.commit(writes, guards)
			}
		}

		await expect(storeVolume(racy).writeFile('/notes/kyoto.md', enc.encode('go'))).rejects.toThrow(
			/^ENOENT/
		)
		expect(raced).toBe(true)
		expect(await vol.exists('/notes')).toBe(false)
		expect((await store.get(notes.id))?.deleted).toBe(true)
	})

	it('replans a claim when its parent moved before the commit', async () => {
		const store = memStore()
		const other = storeVolume(store)
		await other.mkdir('/d')
		const dir = await rowAt(store, '/d')
		let raced = false
		const racy: Store = {
			...store,
			async commit(writes, guards) {
				if (!raced && writes.some((row) => row.parent === dir.id && row.name === 'x')) {
					raced = true
					await other.rename('/d', '/e')
					await other.writeFile('/e/x', enc.encode('other'), { exclusive: true })
				}
				return store.commit(writes, guards)
			}
		}

		await expect(
			storeVolume(racy).writeFile('/d/x', enc.encode('mine'), { exclusive: true })
		).rejects.toThrow(/^ENOENT/)
		expect(raced).toBe(true)
		expect(await read(other, '/e/x')).toBe('other')
	})

	it('lets two creates in one directory both land', async () => {
		// The price of guarding the parent: creates in one directory replan instead
		// of blocking, the way a real filesystem takes that directory's lock. What
		// they must never do is report EEXIST at each other — the name was free.
		const vol = storeVolume(memStore())
		await vol.mkdir('/notes')

		await Promise.all([
			vol.writeFile('/notes/a.md', enc.encode('a')),
			vol.writeFile('/notes/b.md', enc.encode('b')),
			vol.mkdir('/notes/c'),
			vol.symlink('/notes/a.md', '/notes/d')
		])

		expect((await vol.readdir('/notes')).map((e) => e.name)).toEqual(['a.md', 'b.md', 'c', 'd'])
	})

	it('rides in the same commit as a delete and as a rename', async () => {
		const store = memStore()
		const vol = storeVolume(store)
		await vol.mkdir('/notes')
		await vol.writeFile('/notes/kyoto.md', enc.encode('go'))

		let before = await rowAt(store, '/notes')
		await vol.rename('/notes/kyoto.md', '/notes/osaka.md')
		expect((await rowAt(store, '/notes')).version).not.toBe(before.version)

		before = await rowAt(store, '/notes')
		await vol.rm('/notes/osaka.md')
		expect((await rowAt(store, '/notes')).version).not.toBe(before.version)
	})
})

describe('mkdir', () => {
	it('creates a directory row and refuses a taken name', async () => {
		const store = memStore()
		const vol = storeVolume(store)

		await vol.mkdir('/trips')
		const row = await rowAt(store, '/trips')
		expect(row.type).toBe('dir')
		expect(row.mode).toBe(0o040755)
		expect((await vol.stat('/trips')).type).toBe(FileType.Directory)
		await expect(vol.mkdir('/trips')).rejects.toThrow(/^EEXIST/)
	})

	it('takes a mode, and keeps the directory type bits', async () => {
		const store = memStore()
		await storeVolume(store).mkdir('/trips', { mode: 0o700 })
		expect((await rowAt(store, '/trips')).mode).toBe(0o040700)
	})

	it('throws ENOENT when a parent is missing and the walk is not recursive', async () => {
		await expect(storeVolume(memStore()).mkdir('/a/b')).rejects.toThrow(/^ENOENT/)
	})

	it('passes over a folder with -p, never over a file', async () => {
		const vol = storeVolume(memStore())
		await vol.mkdir('/trips/kyoto/east', { recursive: true })
		await vol.mkdir('/trips/kyoto/east', { recursive: true }) // idempotent, as -p promises
		expect((await vol.readdir('/trips/kyoto')).map((e) => e.name)).toEqual(['east'])

		await vol.writeFile('/kyoto.md', enc.encode('note'))
		await expect(vol.mkdir('/kyoto.md', { recursive: true })).rejects.toThrow(/^EEXIST/)
		// A file part-way along names the component that blocks.
		await expect(vol.mkdir('/kyoto.md/sub/deeper', { recursive: true })).rejects.toThrow(
			/^ENOTDIR: \/kyoto\.md$/
		)
		expect(await read(vol, '/kyoto.md')).toBe('note')
	})

	it('lets two racing -p walks both report success', async () => {
		const vol = storeVolume(memStore())
		const results = await Promise.allSettled([
			vol.mkdir('/trips/kyoto', { recursive: true }),
			vol.mkdir('/trips/osaka', { recursive: true })
		])

		for (const result of results) expect(result.status).toBe('fulfilled')
		expect((await vol.readdir('/trips')).map((e) => e.name)).toEqual(['kyoto', 'osaka'])
	})
})

describe('appendFile', () => {
	it('is a create when there is nothing to append to', async () => {
		const vol = storeVolume(memStore())
		await vol.appendFile('/log.md', enc.encode('start'))
		expect(await read(vol, '/log.md')).toBe('start')
	})

	it('reads, merges and writes the whole row', async () => {
		const vol = storeVolume(memStore())
		await vol.writeFile('/log.md', enc.encode('start'))
		await vol.appendFile('/log.md', enc.encode('-more'))
		expect(await read(vol, '/log.md')).toBe('start-more')
	})

	it('keeps both entries when two appends to one file overlap', async () => {
		// Unordered, both appends read `start` and the later put drops the earlier
		// entry. Here the version guard rejects the loser and it reads again.
		const vol = storeVolume(memStore())
		await vol.writeFile('/journal.md', enc.encode('start'))

		await Promise.all([
			vol.appendFile('/journal.md', enc.encode('-a')),
			vol.appendFile('/journal.md', enc.encode('-b'))
		])

		expect(await read(vol, '/journal.md')).toMatch(/^start(-a-b|-b-a)$/)
	})

	it('does not let a full write vanish inside an append', async () => {
		const vol = storeVolume(memStore())
		await vol.writeFile('/note.md', enc.encode('old'))

		await Promise.all([
			vol.appendFile('/note.md', enc.encode('\nentry')),
			vol.writeFile('/note.md', enc.encode('edited'))
		])

		// `old\nentry` is only reachable unguarded: the append read the pre-edit body,
		// the save committed, and the merge overwrote it — the typing is gone while
		// the buffer counts as saved.
		expect(['edited', 'edited\nentry']).toContain(await read(vol, '/note.md'))
	})

	it('throws EISDIR on a directory', async () => {
		const vol = storeVolume(memStore())
		await vol.mkdir('/trips')
		await expect(vol.appendFile('/trips', enc.encode('x'))).rejects.toThrow(/^EISDIR/)
	})
})

describe('chmod, utimes and xattrs', () => {
	it('replaces permission bits and keeps the type bits', async () => {
		const store = memStore()
		const vol = storeVolume(store)
		await vol.writeFile('/kyoto.md', enc.encode('go'))
		await vol.mkdir('/trips')

		await vol.chmod('/kyoto.md', 0o600)
		await vol.chmod('/trips', 0o700)

		expect((await rowAt(store, '/kyoto.md')).mode).toBe(0o100600)
		expect((await rowAt(store, '/trips')).mode).toBe(0o040700)
		expect((await vol.stat('/kyoto.md')).mode).toBe(0o600)
		expect((await vol.stat('/trips')).type).toBe(FileType.Directory)
	})

	it('sets mtime, and reports it as ctime too', async () => {
		const vol = storeVolume(memStore())
		await vol.writeFile('/kyoto.md', enc.encode('go'))

		await vol.utimes('/kyoto.md', 1_234n)

		const stat = await vol.stat('/kyoto.md')
		expect(stat.mtimeNs).toBe(1_234n)
		expect(stat.ctimeNs).toBe(1_234n)
	})

	it('writes and removes xattrs inside the row', async () => {
		const store = memStore()
		const vol = storeVolume(store)
		await vol.writeFile('/kyoto.md', enc.encode('go'))

		await vol.setXattr('/kyoto.md', 'user.tag', enc.encode('trip'))
		await vol.setXattr('/kyoto.md', 'user.mood', enc.encode('warm'))
		expect(await vol.getXattr('/kyoto.md', 'user.tag')).toEqual(enc.encode('trip'))
		expect((await vol.listXattr('/kyoto.md')).sort()).toEqual(['user.mood', 'user.tag'])

		await vol.removeXattr('/kyoto.md', 'user.tag')
		expect(await vol.getXattr('/kyoto.md', 'user.tag')).toBe(null)
		expect(await vol.listXattr('/kyoto.md')).toEqual(['user.mood'])
		// No separate store: the values live on the one row.
		expect(Object.keys((await rowAt(store, '/kyoto.md')).xattrs ?? {})).toEqual(['user.mood'])
	})

	it('throws ENOENT on a missing path', async () => {
		const vol = storeVolume(memStore())
		await expect(vol.chmod('/nope', 0o600)).rejects.toThrow(/^ENOENT/)
		await expect(vol.utimes('/nope', 1n)).rejects.toThrow(/^ENOENT/)
		await expect(vol.setXattr('/nope', 'user.tag', enc.encode('x'))).rejects.toThrow(/^ENOENT/)
	})
})

describe('symlink', () => {
	it('writes the target inline on the row', async () => {
		const store = memStore()
		const vol = storeVolume(store)
		await vol.writeFile('/target.txt', enc.encode('original'))

		await vol.symlink('/target.txt', '/link')

		const row = await rowAt(store, '/link')
		expect(row.type).toBe('symlink')
		expect(row.mode).toBe(0o120777)
		expect(row.link).toBe('/target.txt')
		expect(row.size).toBe(11n)
		expect(await vol.readlink('/link')).toBe('/target.txt')
		expect(await read(vol, '/link')).toBe('original')
	})

	it('refuses a taken name', async () => {
		const vol = storeVolume(memStore())
		await vol.writeFile('/kyoto.md', enc.encode('go'))
		await expect(vol.symlink('/target.txt', '/kyoto.md')).rejects.toThrow(/^EEXIST/)
	})
})

describe('rename', () => {
	it('commits exactly three rows: the node and both parents', async () => {
		const store = memStore()
		const vol = storeVolume(store)
		await vol.mkdir('/trips')
		await vol.mkdir('/archive')
		await vol.writeFile('/trips/kyoto.md', enc.encode('note'))
		const moved = await rowAt(store, '/trips/kyoto.md')
		const commit = vi.spyOn(store, 'commit')

		await vol.rename('/trips/kyoto.md', '/archive/kyoto.md')

		const [writes] = commit.mock.calls[0] ?? []
		expect(writes).toHaveLength(3)
		expect(writes?.map((w) => w.id)).toContain(moved.id)
		expect(await read(vol, '/archive/kyoto.md')).toBe('note')
		expect(await vol.exists('/trips/kyoto.md')).toBe(false)
		// The id is never rebound: the same row moved.
		expect((await rowAt(store, '/archive/kyoto.md')).id).toBe(moved.id)
	})

	it('replaces an occupied destination with a tombstone in the same commit', async () => {
		const store = memStore()
		const vol = storeVolume(store)
		await vol.writeFile('/kyoto.md', enc.encode('theirs'))
		await vol.mkdir('/trips')
		await vol.writeFile('/trips/kyoto.md', enc.encode('mine'))
		const displaced = await rowAt(store, '/kyoto.md')
		const commit = vi.spyOn(store, 'commit')

		await vol.rename('/trips/kyoto.md', '/kyoto.md')

		const [writes] = commit.mock.calls[0] ?? []
		expect(writes?.find((w) => w.id === displaced.id)?.deleted).toBe(true)
		expect(await read(vol, '/kyoto.md')).toBe('mine')
		expect(await vol.exists('/trips/kyoto.md')).toBe(false)
		expect((await vol.readdir('/trips')).map((e) => e.name)).toEqual([])
	})

	it('replaces like for like, and never a directory that still holds entries', async () => {
		// A tombstoned directory leaves its children parented on a tombstone —
		// unreachable, which is the same as losing them. POSIX refuses the whole
		// class, so this does too.
		const vol = storeVolume(memStore())
		await vol.writeFile('/incoming.txt', enc.encode('mine'))
		await vol.mkdir('/archive')
		await vol.writeFile('/archive/kyoto.md', enc.encode('go'))
		await vol.mkdir('/trips')

		await expect(vol.rename('/incoming.txt', '/archive')).rejects.toThrow(/^EISDIR/)
		await expect(vol.rename('/trips', '/incoming.txt')).rejects.toThrow(/^ENOTDIR/)
		await expect(vol.rename('/trips', '/archive')).rejects.toThrow(/^ENOTEMPTY/)
		expect(await read(vol, '/archive/kyoto.md')).toBe('go')

		// An EMPTY directory is replaced, as POSIX has it.
		await vol.mkdir('/empty')
		await vol.rename('/trips', '/empty')
		expect(await vol.exists('/trips')).toBe(false)
		expect((await vol.stat('/empty')).type).toBe(FileType.Directory)
	})

	it('moves a folder with everything under it', async () => {
		const vol = storeVolume(memStore())
		await vol.mkdir('/trips')
		await vol.writeFile('/trips/kyoto.md', enc.encode('note'))

		await vol.rename('/trips', '/journeys')

		expect(await read(vol, '/journeys/kyoto.md')).toBe('note')
		expect(await vol.exists('/trips')).toBe(false)
	})

	it('moves the link, not what it points at', async () => {
		const vol = storeVolume(memStore())
		await vol.writeFile('/target.txt', enc.encode('original'))
		await vol.symlink('/target.txt', '/link')

		await vol.rename('/link', '/moved')

		expect((await vol.lstat('/moved')).type).toBe(FileType.Symlink)
		expect(await read(vol, '/target.txt')).toBe('original')
	})

	it('throws ENOENT when there is nothing to move', async () => {
		const vol = storeVolume(memStore())
		await expect(vol.rename('/nope', '/gone')).rejects.toThrow(/^ENOENT/)
	})

	it('is one feed entry for a directory of 4,000 children (proof 1 of 4)', async () => {
		const store = memStore()
		const vol = storeVolume(store)
		await vol.mkdir('/trips')
		await vol.mkdir('/archive')
		const trips = await rowAt(store, '/trips')
		// Seeded straight through the seam: the point of the test is the MOVE.
		await store.commit(
			Array.from({ length: 4_000 }, (_, i) => ({
				id: crypto.randomUUID(),
				parent: trips.id,
				name: `n${String(i).padStart(4, '0')}.md`,
				type: 'file' as const,
				mode: 0o100644,
				mtimeNs: 1_000n,
				size: 0n,
				version: 'seed'
			}))
		)
		const cursor = await tip(store)

		await vol.rename('/trips', '/archive/trips')

		// One row for the moved node, one for each parent. The 4,000 children never
		// moved: their location is `(parent, name)`, and neither field changed.
		const rows = await feed(store, cursor)
		expect(rows).toHaveLength(3)
		expect(rows.map((r) => r.id).sort()).toEqual(
			[trips.id, ROOT, (await rowAt(store, '/archive')).id].sort()
		)
		expect((await vol.readdir('/archive/trips')).length).toBe(4_000)
	})
})

describe('rm', () => {
	it('tombstones a file and stamps its parent', async () => {
		const store = memStore()
		const vol = storeVolume(store)
		await vol.writeFile('/kyoto.md', enc.encode('go'))
		const row = await rowAt(store, '/kyoto.md')

		await vol.rm('/kyoto.md')

		expect(await vol.exists('/kyoto.md')).toBe(false)
		expect((await store.get(row.id))?.deleted).toBe(true)
	})

	it('removes the link itself, not its target', async () => {
		const vol = storeVolume(memStore())
		await vol.writeFile('/target.txt', enc.encode('original'))
		await vol.symlink('/target.txt', '/link')

		await vol.rm('/link')

		expect(await vol.exists('/link')).toBe(false)
		expect(await read(vol, '/target.txt')).toBe('original')
	})

	it('refuses a non-empty directory without recursive, and forgives a missing path with force', async () => {
		const vol = storeVolume(memStore())
		await vol.mkdir('/trips')
		await vol.writeFile('/trips/kyoto.md', enc.encode('go'))

		await expect(vol.rm('/trips')).rejects.toThrow(/^ENOTEMPTY/)
		await expect(vol.rm('/nope')).rejects.toThrow(/^ENOENT/)
		await vol.rm('/nope', { force: true })
		await vol.rm('/trips/kyoto.md')
		await vol.rm('/trips') // empty now
		expect(await vol.exists('/trips')).toBe(false)
	})

	it('removes a subtree in one guarded batch', async () => {
		const store = memStore()
		const vol = storeVolume(store)
		await vol.mkdir('/trips/kyoto/east', { recursive: true })
		await vol.writeFile('/trips/kyoto/east/note.md', enc.encode('go'))
		await vol.writeFile('/trips/index.md', enc.encode('list'))
		const commit = vi.spyOn(store, 'commit')

		await vol.rm('/trips', { recursive: true })

		expect(commit).toHaveBeenCalledTimes(1)
		const [writes, guards] = commit.mock.calls[0] ?? []
		// Five tombstones (the tree) plus the root's stamp, and one guard per row
		// the batch replaces — the stamped root included.
		expect(writes?.filter((w) => w.deleted)).toHaveLength(5)
		expect(writes).toHaveLength(6)
		expect(guards).toHaveLength(6)
		expect(await vol.exists('/trips')).toBe(false)
	})

	it('fails the batch on a create it did not see, then re-enumerates and retries', async () => {
		// The whole reason a create stamps its parent. The rm enumerated `/notes`;
		// another writer adds a file to it before the batch lands, which moves the
		// `/notes` version the batch guarded on.
		const store = memStore()
		const other = storeVolume(store)
		await other.mkdir('/notes')
		await other.writeFile('/notes/kyoto.md', enc.encode('go'))
		const notes = await rowAt(store, '/notes')

		let raced = false
		const commits: Node[][] = []
		const racy: Store = {
			...store,
			async commit(writes, guards) {
				commits.push(writes)
				if (!raced && writes.some((w) => w.deleted)) {
					raced = true
					await other.writeFile('/notes/late.md', enc.encode('slipped in'))
				}
				return store.commit(writes, guards)
			}
		}

		await storeVolume(racy).rm('/notes', { recursive: true })

		expect(raced).toBe(true)
		// The first batch was rejected; the retry saw `late.md` and took it too.
		expect(commits.filter((writes) => writes.some((w) => w.deleted))).toHaveLength(2)
		expect(await store.child(notes.id, 'late.md')).toBe(null)
		expect(await storeVolume(store).exists('/notes')).toBe(false)
	})

	it('lists what is there when entries vanish mid-listing', async () => {
		// `readdir` reports ROWS, and a row removed between two pages simply is not in
		// the next one. The old volume statted each name after listing it, which is
		// the window this shape has no way to open.
		const store = memStore()
		const vol = storeVolume(store)
		await vol.mkdir('/d')
		const names = Array.from({ length: 200 }, (_, i) => `n${String(i).padStart(3, '0')}.md`)
		for (const name of names) await vol.writeFile(`/d/${name}`, enc.encode('x'))

		let listed = 0
		const vanishing: Store = {
			...store,
			async children(parent, cursor) {
				const page = await store.children(parent, cursor)
				// The instant the first page is answered, take the rest away.
				if (++listed === 1) for (const name of names.slice(128)) await vol.rm(`/d/${name}`)
				return page
			}
		}

		const entries = await storeVolume(vanishing).readdir('/d')
		expect(entries.map((e) => e.name)).toEqual(names.slice(0, 128))
	})
})

describe('cp', () => {
	it('copies a file by reference: a new id, the same content hash, no bytes read', async () => {
		const store = memStore()
		const vol = storeVolume(store)
		await vol.writeFile('/kyoto.md', enc.encode('go'))
		const source = await rowAt(store, '/kyoto.md')
		const get = vi.spyOn(store.blobs, 'get')
		const put = vi.spyOn(store.blobs, 'put')

		await vol.cp('/kyoto.md', '/copy.md')

		const copy = await rowAt(store, '/copy.md')
		expect(copy.id).not.toBe(source.id)
		expect(copy.content).toBe(source.content)
		expect(get).not.toHaveBeenCalled()
		expect(put).not.toHaveBeenCalled()
		expect(await read(vol, '/copy.md')).toBe('go')
	})

	it('replaces a destination link without changing its target', async () => {
		const vol = storeVolume(memStore())
		await vol.writeFile('/target.txt', enc.encode('keep'))
		await vol.symlink('/source-target', '/source')
		await vol.symlink('/target.txt', '/dest')

		await vol.cp('/source', '/dest')

		expect(await vol.readlink('/dest')).toBe('/source-target')
		expect(await read(vol, '/target.txt')).toBe('keep')
	})

	it('retries when a dangling destination link wins the name', async () => {
		const store = memStore()
		const other = storeVolume(store)
		await other.symlink('/source-target', '/source')
		let raced = false
		const racy: Store = {
			...store,
			async commit(writes, guards) {
				if (!raced && writes.some((row) => row.parent === ROOT && row.name === 'dest')) {
					raced = true
					await other.symlink('/missing', '/dest')
				}
				return store.commit(writes, guards)
			}
		}

		await storeVolume(racy).cp('/source', '/dest')

		expect(raced).toBe(true)
		expect(await other.readlink('/dest')).toBe('/source-target')
	})

	it('copies a subtree with new ids and reused hashes', async () => {
		const store = memStore()
		const vol = storeVolume(store)
		await vol.mkdir('/trips/kyoto', { recursive: true })
		await vol.writeFile('/trips/kyoto/note.md', enc.encode('go'))
		await vol.writeFile('/trips/index.md', enc.encode('list'))
		await vol.symlink('/trips/index.md', '/trips/latest')
		const source = await rowAt(store, '/trips/kyoto/note.md')
		const get = vi.spyOn(store.blobs, 'get')

		await vol.cp('/trips', '/archive', { recursive: true })

		// Asserted before anything reads the copy back: the copy itself moved no bytes.
		expect(get).not.toHaveBeenCalled()
		const copy = await rowAt(store, '/archive/kyoto/note.md')
		expect(copy.id).not.toBe(source.id)
		expect(copy.content).toBe(source.content)
		expect(await read(vol, '/archive/kyoto/note.md')).toBe('go')
		expect(await read(vol, '/archive/index.md')).toBe('list')
		expect(await vol.readlink('/archive/latest')).toBe('/trips/index.md')
		// The source is untouched.
		expect(await read(vol, '/trips/kyoto/note.md')).toBe('go')
	})

	it('needs recursive for a directory, and refuses to write a file over one', async () => {
		const vol = storeVolume(memStore())
		await vol.mkdir('/trips')
		await vol.writeFile('/kyoto.md', enc.encode('go'))

		await expect(vol.cp('/trips', '/archive')).rejects.toThrow(/^EISDIR/)
		await expect(vol.cp('/kyoto.md', '/trips')).rejects.toThrow(/^EISDIR/)
	})

	it('refuses to copy a directory into itself', async () => {
		const vol = storeVolume(memStore())
		await vol.mkdir('/a')
		await vol.writeFile('/a/note.md', enc.encode('go'))

		await expect(vol.cp('/a', '/a/b', { recursive: true })).rejects.toThrow(/^EINVAL/)
		await expect(vol.cp('/a', '/a', { recursive: true })).rejects.toThrow(/^EINVAL/)
		await expect(vol.cp('/', '/a/root', { recursive: true })).rejects.toThrow(/^EINVAL/)
		expect((await vol.readdir('/a')).map((e) => e.name)).toEqual(['note.md'])
	})

	it('refuses an aliased destination inside the source before it writes', async () => {
		for (const target of ['/a/existing', '/a']) {
			const store = memStore()
			const vol = storeVolume(store)
			await vol.mkdir('/a/existing', { recursive: true })
			await vol.writeFile('/a/note.md', enc.encode('go'))
			await vol.symlink(target, '/link')
			const commit = vi.spyOn(store, 'commit')
			commit.mockClear()
			commit.mockRejectedValue(new Error('copy wrote before it checked the destination'))

			await expect(vol.cp('/a', '/link/b', { recursive: true })).rejects.toThrow(/^EINVAL/)
			expect(commit).not.toHaveBeenCalled()
		}
	})

	it('overwrites a file at the destination and merges into a directory', async () => {
		const vol = storeVolume(memStore())
		await vol.mkdir('/trips')
		await vol.writeFile('/trips/kyoto.md', enc.encode('new'))
		await vol.mkdir('/archive')
		await vol.writeFile('/archive/kyoto.md', enc.encode('old'))
		await vol.writeFile('/archive/keep.md', enc.encode('keep'))

		await vol.cp('/trips', '/archive', { recursive: true })

		expect(await read(vol, '/archive/kyoto.md')).toBe('new')
		expect(await read(vol, '/archive/keep.md')).toBe('keep')
	})
})

describe('the feed', () => {
	it('carries whole rows, never a patch', async () => {
		const store = memStore()
		const vol = storeVolume(store)
		const cursor = await tip(store)

		await vol.mkdir('/trips')
		await vol.writeFile('/trips/kyoto.md', enc.encode('go'))
		await vol.chmod('/trips/kyoto.md', 0o600)
		await vol.rename('/trips/kyoto.md', '/kyoto.md')
		await vol.rm('/kyoto.md')

		for (const node of await feed(store, cursor)) {
			// Every field a row owes is present on every entry: a consumer reads the
			// state, never a delta it has to apply to something it kept.
			expect(node).toMatchObject({
				id: expect.any(String),
				parent: expect.any(String),
				name: expect.any(String),
				type: expect.any(String),
				mode: expect.any(Number),
				mtimeNs: expect.any(BigInt),
				size: expect.any(BigInt),
				version: expect.any(String)
			})
		}
	})

	it('takes the version format from the caller, for the engine to own later', async () => {
		const store = memStore()
		let n = 0
		const vol = storeVolume(store, { mintVersion: () => `alice:${++n}` })

		await vol.writeFile('/kyoto.md', enc.encode('go'))

		expect((await rowAt(store, '/kyoto.md')).version).toMatch(/^alice:\d+$/)
	})
})
