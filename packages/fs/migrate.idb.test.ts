/**
 * The one pass, on the client: a real old-model IndexedDB database, written
 * through the OLD volume, read back through the NEW one.
 *
 * `fake-indexeddb/auto` MUST be imported FIRST — before anything that touches
 * IDB — because a module that reads `indexedDB` at load time captures whatever
 * is there at that moment.
 */

import 'fake-indexeddb/auto'
import { expect, test } from 'vitest'
import { migrateIdb } from './migrate.idb'
import { idbStorage } from './storage.idb'
import { ROOT, type Store } from './store'
import { idbStore } from './store.idb'
import { volume } from './volume'
import { storeVolume } from './volume.store'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const text = (value: Uint8Array): string => new TextDecoder().decode(value)

/** An old-model database with a tree in it, plus the sync state a migration drops. */
async function fixture(): Promise<{
	name: string
	inos: { docs: string; note: string; link: string }
}> {
	const name = `t16-old-${crypto.randomUUID()}`
	const storage = idbStorage(name)
	const old = volume(storage)
	await old.mkdir('/docs')
	await old.writeFile('/docs/note.md', bytes('hello'))
	await old.writeFile('/docs/copy.md', bytes('hello')) // same bytes, one blob
	await old.setXattr('/docs/note.md', 'ghostore.title', bytes('Note'))
	await old.setXattr('/docs/note.md', 'trusted.sync.baseline', bytes('local only'))
	await old.symlink('/docs/note.md', '/link')
	await old.chmod('/docs', 0o700)
	// Engine bookkeeping. Local-only in the old model, and gone in the new one.
	await old.mkdir('/.state')
	await old.writeFile('/.state/sync', bytes('{"schemaVersion":1}'))
	await old.writeFile('/.state/clientid', bytes('"deadbeef"'))
	const inos = {
		docs: (await old.lstat('/docs')).ino,
		note: (await old.lstat('/docs/note.md')).ino,
		link: (await old.lstat('/link')).ino
	}
	storage.destroy()
	return { name, inos }
}

const fresh = (): Store => idbStore(`t16-new-${crypto.randomUUID()}`)

test('the tree, its ids, its content hashes and its blobs all survive one pass', async () => {
	const { name, inos } = await fixture()
	const store = fresh()
	await migrateIdb(name, store)

	const vol = storeVolume(store)
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
	const copy = await store.child((await store.get(inos.docs))?.id ?? ROOT, 'copy.md')
	expect(note?.content).toBeDefined()
	expect(copy?.content).toBe(note?.content)
	expect(await store.blobs.has(note?.content ?? '')).toBe(true)
})

test('user xattrs survive; the local-only `trusted.sync.*` ones do not', async () => {
	const { name, inos } = await fixture()
	const store = fresh()
	await migrateIdb(name, store)

	expect((await store.get(inos.note))?.xattrs).toEqual({ 'ghostore.title': bytes('Note') })
})

test('sync state is dropped: `/.state` does not exist afterwards', async () => {
	const { name } = await fixture()
	const store = fresh()
	await migrateIdb(name, store)

	expect(await storeVolume(store).exists('/.state')).toBe(false)
	expect(await store.child(ROOT, '.state')).toBeNull()
})

test('the pass is idempotent: a second run writes no row and moves no position', async () => {
	const { name } = await fixture()
	const store = fresh()
	await migrateIdb(name, store)

	const after = await store.since()
	await migrateIdb(name, store)

	expect(await store.since(after.next)).toMatchObject({ nodes: [] })
	expect((await store.since()).nodes).toEqual(after.nodes)
})

test('a tree wider than one commit lands whole, parents before children', async () => {
	const name = `t16-wide-${crypto.randomUUID()}`
	const storage = idbStorage(name)
	const old = volume(storage)
	await old.mkdir('/a/b/c', { recursive: true })
	// More than one batch, so the walk has to keep `/a/b/c` in an earlier commit
	// than the files inside it.
	for (let i = 0; i < 300; i++) await old.writeFile(`/a/b/c/f${i}.txt`, bytes(`n${i}`))
	// `.state` is a ROOT-level name. One deeper in the tree is ordinary user data.
	await old.mkdir('/a/.state')
	await old.writeFile('/a/.state/keep', bytes('mine'))
	storage.destroy()

	const store = fresh()
	await migrateIdb(name, store)

	const vol = storeVolume(store)
	expect((await vol.readdir('/a/b/c')).length).toBe(300)
	expect(text(await vol.readFile('/a/b/c/f299.txt'))).toBe('n299')
	expect(text(await vol.readFile('/a/.state/keep'))).toBe('mine')
})
