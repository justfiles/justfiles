/**
 * The pass on both halves of a real pair, and the one claim that decides
 * whether it may ship: a migrated client and a migrated server converge with
 * nothing on the wire.
 *
 * The fixture is built through the OLD stack end to end — a client writes into
 * `packages/sync`'s journaled IndexedDB backend, and its node operations are
 * applied to the SQLite server, so the two hold the same tree under the same
 * shared sync ids and each holds its OWN local inodes. That last part is what
 * the pass has to get right: the ino is per-replica, so a migration that used it
 * as the row id would give the two sides different ids for the same file, and
 * the first sync would re-upload the entire volume.
 *
 * `fake-indexeddb/auto` MUST be imported FIRST — before anything that touches
 * IDB — because a module that reads `indexedDB` at load time captures whatever
 * is there at that moment.
 */

import 'fake-indexeddb/auto'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { volume } from '@justfiles/fs'
import { migrateIdb } from '@justfiles/fs/migrate.idb'
import { type Cursor, type Node, ROOT, type Store } from '@justfiles/fs/store'
import { storageSyncReplica } from '@justfiles/sync'
import { idbStorage } from '@justfiles/sync/storage/idb'
import { expect, test } from 'vitest'
import { type CursorSlot, sync } from '../../fs/engine'
import { idbStore } from '../../fs/store.idb'
import { storeVolume } from '../../fs/volume.store'
import { createSqliteAdapter, createSqliteSyncDb } from './db.sqlite'
import { migrateSqlite } from './migrate.sqlite'
import { storage as sqliteStorage } from './storage.sqlite'
import { sqliteStore } from './store.sqlite'

const migrationsDir = new URL('./migrations/', import.meta.url)
const schema = readdirSync(migrationsDir)
	.filter((file) => file.endsWith('.sql'))
	.sort()
	.map((file) => readFileSync(new URL(file, migrationsDir), 'utf8'))
	.join('\n')

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const text = (value: Uint8Array): string => new TextDecoder().decode(value)

function openSqlite() {
	const db = new DatabaseSync(':memory:')
	db.exec(schema)
	const adapter = createSqliteAdapter({
		prepare(sql: string) {
			const statement = db.prepare(sql)
			statement.setReadBigInts(true)
			return statement
		},
		exec: (sql: string) => db.exec(sql)
	} as unknown as Parameters<typeof createSqliteAdapter>[0])
	// Two seams over ONE connection: the old tables are read through the async
	// adapter, and the new store commits through the synchronous one it needs to be
	// atomic (`db.ts`). The reads are awaited before each commit, so no `BEGIN` of
	// one ever opens inside the other's.
	const sync = createSqliteSyncDb({
		prepare(sql: string) {
			const statement = db.prepare(sql)
			statement.setReadBigInts(true)
			return statement
		},
		exec: (sql: string) => db.exec(sql)
	} as unknown as Parameters<typeof createSqliteSyncDb>[0])
	return { db, adapter, sync, storage: sqliteStorage(adapter) }
}

function replicaOf(storage: Parameters<typeof storageSyncReplica>[0]) {
	const selected = storageSyncReplica(storage)
	if (selected.strategy !== 'incremental') throw new Error('expected incremental sync')
	return selected.replica
}

/**
 * A client and a server that already agree, through the OLD stack: the client
 * writes, and its node operations are applied to the server verbatim.
 */
async function converged() {
	const server = openSqlite()
	const clientDb = `t16-client-${crypto.randomUUID()}`
	const clientStorage = idbStorage(clientDb)
	const client = volume(clientStorage)

	await client.mkdir('/docs')
	await client.writeFile('/docs/note.md', bytes('hello'))
	await client.writeFile('/docs/copy.md', bytes('hello')) // same bytes, one blob
	await client.setXattr('/docs/note.md', 'ghostore.title', bytes('Note'))
	await client.symlink('/docs/note.md', '/link')
	await client.mkdir('/.state')
	await client.writeFile('/.state/sync', bytes('{"schemaVersion":1}'))

	const source = replicaOf(clientStorage)
	const delta = await source.nodeDeltas('', { limit: 500 })
	await replicaOf(server.storage).applyNodeOperations(delta.operations, (hash) =>
		source.getBlobByHash(hash)
	)
	// The fixture is only worth migrating if the old stack really converged.
	expect(text(await volume(server.storage).readFile('/docs/note.md'))).toBe('hello')

	return { server, clientDb, clientStorage }
}

/** Rows in one order both backends agree on — the feed's own is per-replica. */
const byId = (nodes: Node[]): Node[] => [...nodes].sort((a, b) => (a.id < b.id ? -1 : 1))

/** Every row in a feed, in feed order. */
async function rows(store: Store): Promise<Node[]> {
	const out: Node[] = []
	let cursor: Cursor | undefined
	for (let page = 0; page < 100; page++) {
		const next = await store.since(cursor)
		out.push(...next.nodes)
		cursor = next.next
		if (next.nodes.length === 0) return out
	}
	throw new Error('feed did not end')
}

function slot(): CursorSlot {
	let at: Cursor | undefined
	return {
		load: async () => at,
		save: async (cursor: Cursor | undefined) => {
			at = cursor
		}
	}
}

/** A store that counts what a sync actually made it do. */
function counted(store: Store): Store & { commits: Node[][]; puts: string[] } {
	const commits: Node[][] = []
	const puts: string[] = []
	return {
		...store,
		commits,
		puts,
		commit(writes, guards) {
			commits.push(writes)
			return store.commit(writes, guards)
		},
		blobs: {
			has: (hash) => store.blobs.has(hash),
			get: (hash) => store.blobs.get(hash),
			put(hash, data) {
				puts.push(hash)
				return store.blobs.put(hash, data)
			}
		}
	}
}

test('both halves migrate to the same rows, under the same shared ids', async () => {
	const { server, clientDb, clientStorage } = await converged()
	// The old models disagree about local inodes on purpose — that is what a
	// migration keyed on the ino would carry into the new one.
	expect((await volume(clientStorage).lstat('/docs/note.md')).ino).not.toBe(
		(await volume(server.storage).lstat('/docs/note.md')).ino
	)

	const local = idbStore(`t16-local-${crypto.randomUUID()}`)
	const remote = sqliteStore(server.sync)
	await migrateIdb(clientDb, local)
	await migrateSqlite(server.adapter, remote)

	const mine = await rows(local)
	// Root, /docs, two files under it, and the symlink.
	expect(mine.length).toBe(5)
	expect(byId(mine)).toEqual(byId(await rows(remote)))
	// The tree reads back on both sides, the bytes are there, and `/.state` is gone.
	for (const store of [local, remote]) {
		const vol = storeVolume(store)
		expect(text(await vol.readFile('/docs/note.md'))).toBe('hello')
		expect(await vol.readlink('/link')).toBe('/docs/note.md')
		expect(await vol.exists('/.state')).toBe(false)
		const note = await vol.lstat('/docs/note.md')
		expect(note.contentHash).toBeDefined()
		expect(await store.blobs.has(note.contentHash ?? '')).toBe(true)
		expect(await store.child(ROOT, '.state')).toBeNull()
	}
	// Every migrated row is authored by the pass, on both sides, so no replica
	// claims one and the version is identical wherever the row is.
	expect(
		mine.filter((row) => row.id !== ROOT).every((row) => row.version.startsWith('migrated:'))
	).toBe(true)
	server.db.close()
})

test('the first sync after migration writes no row and moves no blob', async () => {
	const { server, clientDb } = await converged()
	const local = counted(idbStore(`t16-local-${crypto.randomUUID()}`))
	const remote = counted(sqliteStore(server.sync))
	await migrateIdb(clientDb, local)
	await migrateSqlite(server.adapter, remote)

	const before = { local: await rows(local), remote: await rows(remote) }
	local.commits.length = 0
	remote.commits.length = 0
	local.puts.length = 0
	remote.puts.length = 0

	await sync(local, remote, { replica: 'client-a', pull: slot(), push: slot() })

	// The push offers nothing at all: every migrated row is authored `migrated`,
	// which is no live replica, so the author filter empties the page.
	expect(remote.commits).toEqual([])
	// The pull scans the server's whole feed — it has no cursor yet — and every
	// page lands as a no-op, because the rows are identical on both sides.
	expect(local.commits.length).toBeGreaterThan(0)
	expect(await rows(local)).toEqual(before.local)
	expect(await rows(remote)).toEqual(before.remote)
	// And not one byte of content moves in either direction — which means
	// something only because both sides went in holding the bytes already.
	const hash = (await storeVolume(local).lstat('/docs/note.md')).contentHash ?? ''
	expect(await local.blobs.has(hash)).toBe(true)
	expect(await remote.blobs.has(hash)).toBe(true)
	expect(local.puts).toEqual([])
	expect(remote.puts).toEqual([])
	server.db.close()
})

test('a second pass over the same tables writes nothing', async () => {
	const { server } = await converged()
	const store = sqliteStore(server.sync)
	await migrateSqlite(server.adapter, store)

	const after = await store.since()
	await migrateSqlite(server.adapter, store)

	expect(await store.since(after.next)).toMatchObject({ nodes: [] })
	expect((await store.since()).nodes).toEqual(after.nodes)
	server.db.close()
})

test('content the old server offloaded comes from the bucket, or the row is a stub', async () => {
	const { server, clientDb } = await converged()
	const hash = (await volume(server.storage).lstat('/docs/note.md')).contentHash ?? ''
	// Rewrite the row the way a bucket-backed server held it: the bytes are out
	// in R2 under a key, and `fs_contents` keeps only the key.
	await server.adapter.run(
		"UPDATE fs_contents SET storage_kind = 2, inline_bytes = NULL, r2_key = 'ns/note' WHERE content_hash = ?",
		[hash]
	)

	const stub = sqliteStore(server.sync)
	await migrateSqlite(server.adapter, stub)
	expect((await stub.get((await storeVolume(stub).lstat('/docs/note.md')).ino))?.content).toBe(hash)
	expect(await stub.blobs.has(hash)).toBe(false)

	const whole = idbStore(`t16-r2-${crypto.randomUUID()}`)
	await migrateSqlite(server.adapter, whole, {
		get: async (key) =>
			key === 'ns/note' ? { arrayBuffer: async () => bytes('hello').buffer as ArrayBuffer } : null
	})
	expect(await whole.blobs.has(hash)).toBe(true)
	expect(text(await storeVolume(whole).readFile('/docs/note.md'))).toBe('hello')
	// The client still holds its own copy, so a stubbed server costs nothing there.
	const client = idbStore(`t16-r2c-${crypto.randomUUID()}`)
	await migrateIdb(clientDb, client)
	expect(await client.blobs.has(hash)).toBe(true)
	server.db.close()
})
