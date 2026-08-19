/**
 * The pass on both halves of a real pair, and the one claim that decides
 * whether it may ship: a migrated client and a migrated server converge with
 * nothing on the wire.
 *
 * The fixture states the old model rather than driving it — the stack that used
 * to write it is gone. That is the honest way round for what is being claimed
 * here anyway, because the claim is about a DISAGREEMENT the old stack produced
 * as a side effect: the two sides hold one tree under the same shared sync ids,
 * and each holds its OWN local inodes (a node arriving from a peer was given a
 * fresh local ino). A migration that used the ino as the row id would therefore
 * give the two sides different ids for the same file, and the first sync would
 * re-upload the entire volume. So the fixture says exactly that, in one place:
 * one tree, two ino namespaces, one set of sync ids.
 *
 * `fake-indexeddb/auto` MUST be imported FIRST — before anything that touches
 * IDB — because a module that reads `indexedDB` at load time captures whatever
 * is there at that moment.
 */

import 'fake-indexeddb/auto'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { volume } from '@justfiles/fs'
import { idbStore } from '@justfiles/fs/idb'
import { migrateIdb } from '@justfiles/fs/migrate.idb'
import {
	dir,
	file,
	LEGACY_MTIME_NS,
	LEGACY_ROOT,
	type LegacyNode,
	symlink,
	writeLegacyIdb
} from '@justfiles/fs/migrate.legacy'
import { type Cursor, type Node, ROOT, type Store, sha256Hex } from '@justfiles/fs/store'
import { expect, test } from 'vitest'
import { type CursorSlot, sync } from '../../fs/engine'
import type { DbAdapter } from './db'
import { createSqliteAdapter, createSqliteSyncDb } from './db.sqlite'
import { migrateSqlite } from './migrate.sqlite'
import { sqliteStore } from './store.sqlite'

const migrationsDir = new URL('./migrations/', import.meta.url)
const schema = readdirSync(migrationsDir)
	.filter((name) => name.endsWith('.sql'))
	.sort()
	.map((name) => readFileSync(new URL(name, migrationsDir), 'utf8'))
	.join('\n')

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const text = (value: Uint8Array): string => new TextDecoder().decode(value)

// ── The fixture ───────────────────────────────────────────────────────────────

/**
 * One node, keyed by the identity BOTH replicas share. `parent` is another key,
 * or `''` for a root entry — an ino is per-side, so the description cannot name
 * one.
 */
type Spec = Omit<LegacyNode, 'ino' | 'parent' | 'id'> & { key: string; parent: string }

const spec = (parent: string, key: string, node: Omit<LegacyNode, 'ino' | 'parent'>): Spec => ({
	...node,
	key,
	parent
})

const NOTE_XATTRS = { 'ghostore.title': bytes('Note') }

/** What the two sides agree on. Every node here synced, so every one has a shared id. */
const SHARED: Spec[] = [
	spec('', 'docs', dir('', '', 'docs')),
	spec('docs', 'note', { ...file('', '', 'note.md', bytes('hello')), xattrs: NOTE_XATTRS }),
	spec('docs', 'copy', file('', '', 'copy.md', bytes('hello'))), // same bytes, one blob
	spec('', 'link', symlink('', '', 'link', '/docs/note.md'))
]

/** Client-only: the old engine's private tree, which the pass drops. */
const CLIENT_ONLY: Spec[] = [
	spec('', 'state', dir('', '', '.state')),
	spec('state', 'state-sync', file('', '', 'sync', bytes('{"schemaVersion":1}')))
]

const localOnly = new Set(CLIENT_ONLY.map((s) => s.key))

/**
 * One side's nodes: the shared ids, and inos in THIS side's namespace. The two
 * prefixes are what make every ino disagree while every sync id agrees.
 */
function side(prefix: string, specs: Spec[]): LegacyNode[] {
	const ino = (key: string) => `${prefix}-${key}`
	return specs.map(({ key, parent, ...node }) => ({
		...node,
		ino: ino(key),
		// `.state` never crossed the wire, so it never had a sync row.
		id: localOnly.has(key) ? undefined : `sync-${key}`,
		parent: parent === '' ? LEGACY_ROOT : ino(parent)
	}))
}

/** The old SQL tables, written directly — the half `migrate.sqlite.ts` reads. */
async function writeLegacySqlite(db: DbAdapter, nodes: LegacyNode[]): Promise<void> {
	const syncIdOf = new Map(nodes.map((node) => [node.ino, node.id]))
	// `fs_dirents.dir_ino` is a foreign key, so the root has to be an inode too.
	await db.run(
		`INSERT OR IGNORE INTO fs_inodes(ino, type, mode, size, mtime_ns, ctime_ns, storage_kind)
		 VALUES (?, 1, 493, 0, 0, 0, 0)`,
		[LEGACY_ROOT]
	)
	for (const node of nodes) {
		const hash = node.content ? await sha256Hex(node.content) : null
		if (node.content && hash)
			await db.run(
				`INSERT OR IGNORE INTO fs_contents(content_hash, storage_kind, size, inline_bytes, created_at_ns)
				 VALUES (?, 1, ?, ?, 0)`,
				[hash, node.content.byteLength, node.content]
			)
		await db.run(
			`INSERT INTO fs_inodes(ino, type, mode, size, mtime_ns, ctime_ns, content_hash, symlink_target, storage_kind)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
			[
				node.ino,
				node.type,
				node.mode,
				BigInt(node.content?.byteLength ?? 0),
				LEGACY_MTIME_NS,
				LEGACY_MTIME_NS,
				hash,
				node.target ?? null
			]
		)
		await db.run('INSERT INTO fs_dirents(dir_ino, name, ino, type) VALUES (?, ?, ?, ?)', [
			node.parent,
			node.name,
			node.ino,
			node.type
		])
		for (const [name, value] of Object.entries(node.xattrs ?? {}))
			await db.run('INSERT INTO fs_xattrs(ino, name, value) VALUES (?, ?, ?)', [
				node.ino,
				name,
				value
			])
		if (node.id !== undefined)
			await db.run(
				`INSERT INTO fs_sync_nodes(sync_id, local_ino, parent_sync_id, name, type, revision, deleted, meta_json, content_hash)
				 VALUES (?, ?, ?, ?, ?, ?, 0, '{}', ?)`,
				[
					node.id,
					node.ino,
					syncIdOf.get(node.parent) ?? null,
					node.name,
					node.type,
					node.revision ?? 0,
					hash
				]
			)
	}
}

function openSqlite() {
	const db = new DatabaseSync(':memory:')
	db.exec(schema)
	const seam = () =>
		({
			prepare(sql: string) {
				const statement = db.prepare(sql)
				statement.setReadBigInts(true)
				return statement
			},
			exec: (sql: string) => db.exec(sql)
		}) as unknown as Parameters<typeof createSqliteAdapter>[0]
	// Two seams over ONE connection: the old tables are read through the async
	// adapter, and the new store commits through the synchronous one it needs to be
	// atomic (`db.ts`). The reads are awaited before each commit, so no `BEGIN` of
	// one ever opens inside the other's.
	return {
		db,
		adapter: createSqliteAdapter(seam()),
		sync: createSqliteSyncDb(seam() as unknown as Parameters<typeof createSqliteSyncDb>[0])
	}
}

/** A client and a server holding one tree: same sync ids, their own inos. */
async function converged() {
	const server = openSqlite()
	await writeLegacySqlite(server.adapter, side('srv', SHARED))
	const clientDb = `t18-client-${crypto.randomUUID()}`
	await writeLegacyIdb(clientDb, side('cli', [...SHARED, ...CLIENT_ONLY]))
	return { server, clientDb }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── The claims ────────────────────────────────────────────────────────────────

test('both halves migrate to the same rows, under the same shared ids', async () => {
	const { server, clientDb } = await converged()
	// The two sides disagree about local inodes on purpose — that is what a
	// migration keyed on the ino would carry into the new model.
	expect(side('cli', SHARED).map((n) => n.ino)).not.toEqual(side('srv', SHARED).map((n) => n.ino))

	const local = idbStore(`t18-local-${crypto.randomUUID()}`)
	const remote = sqliteStore(server.sync)
	await migrateIdb(clientDb, local)
	await migrateSqlite(server.adapter, remote)

	const mine = await rows(local)
	// Root, /docs, two files under it, and the symlink.
	expect(mine.length).toBe(5)
	expect(byId(mine)).toEqual(byId(await rows(remote)))
	// The tree reads back on both sides, the bytes are there, and `/.state` is gone.
	for (const store of [local, remote]) {
		const vol = volume(store)
		expect(text(await vol.readFile('/docs/note.md'))).toBe('hello')
		expect(await vol.readlink('/link')).toBe('/docs/note.md')
		expect(await vol.exists('/.state')).toBe(false)
		const note = await vol.lstat('/docs/note.md')
		expect(note.contentHash).toBeDefined()
		expect(await store.blobs.has(note.contentHash ?? '')).toBe(true)
		expect(await store.child(ROOT, '.state')).toBeNull()
		// The id is the SHARED one on both sides — not either side's ino.
		expect(note.ino).toBe('sync-note')
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
	const local = counted(idbStore(`t18-local-${crypto.randomUUID()}`))
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
	const hash = (await volume(local).lstat('/docs/note.md')).contentHash ?? ''
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
	const hash = await sha256Hex(bytes('hello'))
	// Rewrite the row the way a bucket-backed server held it: the bytes are out
	// in R2 under a key, and `fs_contents` keeps only the key.
	await server.adapter.run(
		"UPDATE fs_contents SET storage_kind = 2, inline_bytes = NULL, r2_key = 'ns/note' WHERE content_hash = ?",
		[hash]
	)

	const stub = sqliteStore(server.sync)
	await migrateSqlite(server.adapter, stub)
	expect((await stub.get((await volume(stub).lstat('/docs/note.md')).ino))?.content).toBe(hash)
	expect(await stub.blobs.has(hash)).toBe(false)

	const whole = idbStore(`t18-r2-${crypto.randomUUID()}`)
	await migrateSqlite(server.adapter, whole, {
		blobs: {
			get: async (key) =>
				key === 'ns/note' ? { arrayBuffer: async () => bytes('hello').buffer as ArrayBuffer } : null
		}
	})
	expect(await whole.blobs.has(hash)).toBe(true)
	expect(text(await volume(whole).readFile('/docs/note.md'))).toBe('hello')
	// The client still holds its own copy, so a stubbed server costs nothing there.
	const client = idbStore(`t18-r2c-${crypto.randomUUID()}`)
	await migrateIdb(clientDb, client)
	expect(await client.blobs.has(hash)).toBe(true)
	server.db.close()
})
