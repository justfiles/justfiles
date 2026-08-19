/**
 * The migration's namespace half: which store a subtree lands in.
 *
 * [T16](../../tasks/store-model/t16-data-migration.md) wrote the pass and left one
 * thing to this task, in its own words: `/private` was kept off the wire by a path
 * filter, this model has no path filter, so a `/private` migrated into the synced
 * store stops being local. The fix is [T15](../../tasks/store-model/t15-mounts.md)'s
 * — another store, joined at that name — and only the host knows its local store,
 * so the pass takes it as `mounts`.
 *
 * The tree here is a hand-made `LegacyTree`, not a real backend: what is on trial is
 * where a row goes, which is the same question on IndexedDB and on SQLite.
 */

import { describe, expect, it } from 'vitest'
import { type Legacy, migrate } from './migrate'
import { type Cursor, type Node, ROOT, sha256Hex, type Store } from './store'
import { memStore } from './store.mem'
import { FileType } from './types'
import { announceMount, type Bindings, storeVolume } from './volume.store'

const enc = new TextEncoder()
const dec = new TextDecoder()

type Entry = Partial<Legacy> & Pick<Legacy, 'ino' | 'name' | 'type'>

/** One old-model tree, as the dirent walk sees it: a directory ino → its entries. */
function legacy(dirs: Record<string, Entry[]>, blobs: Record<string, string> = {}) {
	return {
		entries: async (dir: string): Promise<Legacy[]> =>
			(dirs[dir] ?? []).map((entry) => ({
				id: entry.ino,
				mode: 0o644,
				mtimeNs: 7n,
				size: 0n,
				revision: 0,
				contentHash: null,
				symlinkTarget: null,
				xattrs: {},
				...entry
			})),
		blob: async (hash: string): Promise<Uint8Array | null> =>
			blobs[hash] === undefined ? null : enc.encode(blobs[hash])
	}
}

/** Every live row of a store, by name — enough to say where a subtree landed. */
async function rows(store: Store): Promise<Node[]> {
	const out: Node[] = []
	let cursor: Cursor | undefined
	for (;;) {
		const page = await store.since(cursor)
		out.push(...page.nodes.filter((row) => !row.deleted && row.id !== ROOT))
		if (page.next === undefined || page.nodes.length === 0) return out
		cursor = page.next
	}
}

const names = async (store: Store): Promise<string[]> =>
	(await rows(store)).map((row) => row.name).sort()

describe('migrate: a root-level name whose subtree belongs in another store', () => {
	it('puts the mounted subtree in the bound store, under its own root', async () => {
		const secret = await sha256Hex(enc.encode('shh'))
		const note = await sha256Hex(enc.encode('hello'))
		const from = legacy(
			{
				'1': [
					{ ino: 'd-notes', name: 'notes', type: FileType.Directory },
					{ ino: 'd-priv', name: 'private', type: FileType.Directory },
					{ ino: 'd-state', name: '.state', type: FileType.Directory }
				],
				'd-notes': [
					{ ino: 'f-note', name: 'today.md', type: FileType.Regular, contentHash: note, size: 5n }
				],
				'd-priv': [
					{
						ino: 'f-secret',
						name: 'credentials.json',
						type: FileType.Regular,
						contentHash: secret,
						size: 3n
					},
					{ ino: 'd-cache', name: 'cache', type: FileType.Directory }
				],
				'd-cache': [{ ino: 'f-blob', name: 'app.js', type: FileType.Regular }],
				'd-state': [{ ino: 'f-sync', name: 'sync.json', type: FileType.Regular }]
			},
			{ [secret]: 'shh', [note]: 'hello' }
		)

		const synced = memStore()
		const local = memStore()
		await migrate(from, synced, new Map([['private', local]]))

		// Nothing of the mounted subtree is in the synced store — not the directory
		// row a peer could push into, not a file, not a stub. And `.state` is dropped
		// as T16 says, so the synced store holds the user's tree and nothing else.
		expect(await names(synced)).toEqual(['notes', 'today.md'])
		expect(await synced.child(ROOT, 'private')).toBeNull()
		expect(await synced.blobs.has(secret)).toBe(false)

		// The local store holds it, hanging off ITS root: what was `/private/x` is `x`
		// there, because a mount is where one store's tree stops and another's starts.
		expect(await names(local)).toEqual(['app.js', 'cache', 'credentials.json'])
		const held = await local.child(ROOT, 'credentials.json')
		expect(held?.id).toBe('f-secret')
		expect(dec.decode((await local.blobs.get(secret)) ?? new Uint8Array())).toBe('shh')

		// … and the content of the synced half stayed on the synced side.
		expect(await local.blobs.has(note)).toBe(false)
		expect(await synced.blobs.has(note)).toBe(true)
	})

	it('reads back as one tree once the name is announced and bound', async () => {
		const from = legacy({
			'1': [
				{ ino: 'd-priv', name: 'private', type: FileType.Directory },
				{ ino: 'd-notes', name: 'notes', type: FileType.Directory }
			],
			'd-priv': [{ ino: 'f-env', name: 'env', type: FileType.Regular }],
			'd-notes': []
		})

		const synced = memStore()
		const local = memStore()
		await migrate(from, synced, new Map([['private', local]]))
		// The two halves the host owns: the row that reserves the name for every
		// replica, and the binding that joins its own store in behind it.
		const mount = await announceMount(synced, ROOT, 'private')
		const bindings: Bindings = new Map([[ROOT, new Map([['private', local]])]])
		const vol = storeVolume(synced, { bindings })

		expect((await vol.readdir('/')).map((entry) => entry.name).sort()).toEqual(['notes', 'private'])
		expect(await vol.exists('/private/env')).toBe(true)
		// One namespace, two stores: the path resolves, and the row it resolves to is
		// the bound store's, never the mount point's.
		expect((await vol.stat('/private')).ino).not.toBe(mount)
		expect((await vol.stat('/private')).ino).toBe(ROOT)
	})

	it('leaves the tree alone when the host binds nothing', async () => {
		const from = legacy({
			'1': [{ ino: 'd-priv', name: 'private', type: FileType.Directory }],
			'd-priv': [{ ino: 'f-env', name: 'env', type: FileType.Regular }]
		})
		const synced = memStore()
		await migrate(from, synced)

		// The unmounted case is the OLD behaviour, kept deliberately: a host that
		// names no local store gets its whole tree, and the `migrated` author is what
		// keeps it off the wire until something edits it. A pass that silently dropped
		// the subtree would lose data no other copy holds.
		expect(await names(synced)).toEqual(['env', 'private'])
	})
})
