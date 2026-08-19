/**
 * The one pass, on the client: a real old-model IndexedDB database, read back
 * through the volume.
 *
 * `fake-indexeddb/auto` MUST be imported FIRST — before anything that touches
 * IDB — because a module that reads `indexedDB` at load time captures whatever
 * is there at that moment.
 */

import 'fake-indexeddb/auto'
import { expect, test } from 'vitest'
import { idbStore } from './idb'
import { migrateIdb } from './migrate.idb'
import { dir, file, LEGACY_ROOT, type LegacyNode, symlink, writeLegacyIdb } from './migrate.legacy'
import { ROOT, type Store } from './store'
import { volume } from './volume'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const text = (value: Uint8Array): string => new TextDecoder().decode(value)

const inos = { docs: 'ino-docs', note: 'ino-note', link: 'ino-link' }

/** An old-model tree, plus the sync state a migration drops. */
const tree: LegacyNode[] = [
	dir(inos.docs, LEGACY_ROOT, 'docs', 0o700),
	{
		...file(inos.note, inos.docs, 'note.md', bytes('hello')),
		xattrs: {
			'ghostore.title': bytes('Note'),
			// Local-only in the old model: it never crossed the wire.
			'trusted.sync.baseline': bytes('local only')
		}
	},
	file('ino-copy', inos.docs, 'copy.md', bytes('hello')), // same bytes, one blob
	symlink(inos.link, LEGACY_ROOT, 'link', '/docs/note.md'),
	// Engine bookkeeping. Local-only in the old model, and gone in the new one.
	dir('ino-state', LEGACY_ROOT, '.state'),
	file('ino-sync', 'ino-state', 'sync', bytes('{"schemaVersion":1}')),
	file('ino-clientid', 'ino-state', 'clientid', bytes('"deadbeef"'))
]

async function fixture(): Promise<string> {
	const name = `t18-old-${crypto.randomUUID()}`
	await writeLegacyIdb(name, tree)
	return name
}

const fresh = (): Store => idbStore(`t18-new-${crypto.randomUUID()}`)

test('the tree, its ids, its content hashes and its blobs all survive one pass', async () => {
	const name = await fixture()
	const store = fresh()
	await migrateIdb(name, store)

	const vol = volume(store)
	expect((await vol.readdir('/')).map((entry) => entry.name).sort()).toEqual(['docs', 'link'])
	expect((await vol.readdir('/docs')).map((entry) => entry.name).sort()).toEqual([
		'copy.md',
		'note.md'
	])
	expect(text(await vol.readFile('/docs/note.md'))).toBe('hello')
	expect(await vol.readlink('/link')).toBe('/docs/note.md')
	expect((await vol.lstat('/docs')).mode).toBe(0o700)

	// Ids survive: nothing here was ever synced, so the old ino IS the new id.
	expect((await vol.lstat('/docs')).ino).toBe(inos.docs)
	expect((await vol.lstat('/docs/note.md')).ino).toBe(inos.note)
	expect((await vol.lstat('/link')).ino).toBe(inos.link)

	// One hash, one blob, and the blob is present.
	const note = await store.get(inos.note)
	const copy = await store.child(inos.docs, 'copy.md')
	expect(note?.content).toBeDefined()
	expect(copy?.content).toBe(note?.content)
	expect(await store.blobs.has(note?.content ?? '')).toBe(true)
})

test('user xattrs survive; the local-only `trusted.sync.*` ones do not', async () => {
	const name = await fixture()
	const store = fresh()
	await migrateIdb(name, store)

	expect((await store.get(inos.note))?.xattrs).toEqual({ 'ghostore.title': bytes('Note') })
})

test('sync state is dropped: `/.state` does not exist afterwards', async () => {
	const name = await fixture()
	const store = fresh()
	await migrateIdb(name, store)

	expect(await volume(store).exists('/.state')).toBe(false)
	expect(await store.child(ROOT, '.state')).toBeNull()
})

test('the pass is idempotent: a second run writes no row and moves no position', async () => {
	const name = await fixture()
	const store = fresh()
	await migrateIdb(name, store)

	const after = await store.since()
	await migrateIdb(name, store)

	expect(await store.since(after.next)).toMatchObject({ nodes: [] })
	expect((await store.since()).nodes).toEqual(after.nodes)
})

test('a tree wider than one commit lands whole, parents before children', async () => {
	const name = `t18-wide-${crypto.randomUUID()}`
	const wide: LegacyNode[] = [
		dir('a', LEGACY_ROOT, 'a'),
		dir('b', 'a', 'b'),
		dir('c', 'b', 'c'),
		// `.state` is a ROOT-level name. One deeper in the tree is ordinary user data.
		dir('a-state', 'a', '.state'),
		file('a-keep', 'a-state', 'keep', bytes('mine'))
	]
	// More than one batch, so the walk has to keep `/a/b/c` in an earlier commit
	// than the files inside it.
	for (let i = 0; i < 300; i++) wide.push(file(`f${i}`, 'c', `f${i}.txt`, bytes(`n${i}`)))
	await writeLegacyIdb(name, wide)

	const store = fresh()
	await migrateIdb(name, store)

	const vol = volume(store)
	expect((await vol.readdir('/a/b/c')).length).toBe(300)
	expect(text(await vol.readFile('/a/b/c/f299.txt'))).toBe('n299')
	expect(text(await vol.readFile('/a/.state/keep'))).toBe('mine')
})
