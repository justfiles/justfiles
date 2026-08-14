import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { volume } from '@justfiles/fs'
import { storageSyncReplica } from '@justfiles/sync'
import { ROOT_NODE_ID } from '@justfiles/sync/node'
import { nodeMemStorage } from '@justfiles/sync/storage/node-mem'
import { afterEach, describe, expect, test } from 'vitest'
import { nodeSyncConformanceCases } from '../../sync/node-test-harness'
import type { DbAdapter } from './db'
import { createSqliteAdapter } from './db.sqlite'
import { createFsApi } from './fs'
import { createFsClient, remoteNodeSyncReplica } from './fs.client'
import { storage as sqliteStorage } from './storage.sqlite'

const migrationsDir = new URL('./migrations/', import.meta.url)
const schema = readdirSync(migrationsDir)
	.filter((file) => file.endsWith('.sql'))
	.sort()
	.map((file) => readFileSync(new URL(file, migrationsDir), 'utf8'))
	.join('\n')

const temporaryDirectories: string[] = []

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true })
})

function failNodeJournal(db: DbAdapter, failure?: { enabled: boolean }): DbAdapter {
	if (!failure) return db
	const wrap = (current: DbAdapter): DbAdapter => ({
		query: (statement, args) => current.query(statement, args),
		run(statement, args) {
			if (failure.enabled && /INSERT INTO fs_node_journal/.test(statement))
				return Promise.reject(new Error('injected node journal failure'))
			return current.run(statement, args)
		},
		transaction: (task) => current.transaction((tx) => task(wrap(tx)))
	})
	return wrap(db)
}

function openSqlite(
	filename: string,
	migrate = true,
	sql?: string[],
	failure?: { enabled: boolean }
) {
	const db = new DatabaseSync(filename)
	if (migrate) db.exec(schema)
	const db64 = {
		prepare(statementSql: string) {
			sql?.push(statementSql)
			const statement = db.prepare(statementSql)
			statement.setReadBigInts(true)
			return statement
		},
		exec: (sql: string) => db.exec(sql)
	}
	return {
		db,
		storage: sqliteStorage(
			failNodeJournal(
				createSqliteAdapter(db64 as unknown as Parameters<typeof createSqliteAdapter>[0]),
				failure
			)
		)
	}
}

function wireClient(app: ReturnType<typeof createFsApi>, requests?: string[]) {
	return createFsClient({
		baseUrl: 'http://node-sync.test',
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init)
			requests?.push(`${request.method} ${new URL(request.url).pathname}`)
			return app.request(request)
		}) as typeof fetch
	})
}

function nodeReplica(storage: ReturnType<typeof sqliteStorage>) {
	const selected = storageSyncReplica(storage)
	if (selected.strategy !== 'incremental') throw new Error('expected incremental sync')
	return selected.replica
}

function memoryNodeReplica(storage: ReturnType<typeof nodeMemStorage>) {
	const selected = storageSyncReplica(storage)
	if (selected.strategy !== 'incremental') throw new Error('expected incremental sync')
	return selected.replica
}

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const text = (value: Uint8Array): string => new TextDecoder().decode(value)

describe('node-sync conformance: SQLite', () => {
	for (const behavior of nodeSyncConformanceCases)
		test(behavior.name, () => behavior.run(() => openSqlite(':memory:').storage))
})

test('SQLite keeps a client node identity and its local inode across restart', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'justfiles-node-sync-'))
	temporaryDirectories.push(directory)
	const filename = join(directory, 'fs.db')
	const first = openSqlite(filename)
	const firstReplica = nodeReplica(first.storage)

	await firstReplica.applyNodeOperations(
		[
			{
				mutations: [
					{
						kind: 'create',
						nodeId: 'client-docs',
						parentId: ROOT_NODE_ID,
						name: 'docs',
						revision: 1,
						meta: { type: 1, mode: 0o755, mtimeNs: '0', size: '0' }
					}
				]
			}
		],
		() => Promise.reject(new Error('directory create requested content')),
		{ source: 'client-a' }
	)
	const firstIno = (await volume(first.storage).lstat('/docs')).ino
	first.db.close()

	const second = openSqlite(filename, false)
	const page = await nodeReplica(second.storage).nodeSnapshot(undefined, { limit: 10 })
	expect(page).toMatchObject({
		status: 'ok',
		operations: [
			{
				mutations: [{ kind: 'create', nodeId: 'client-docs', parentId: ROOT_NODE_ID }]
			}
		]
	})
	expect((await volume(second.storage).lstat('/docs')).ino).toBe(firstIno)
	second.db.close()
})

test('HTTP node sync creates on SQLite and bootstraps a new memory client', async () => {
	const server = openSqlite(':memory:')
	const app = createFsApi(server.storage)
	const client = wireClient(app)
	const remote = remoteNodeSyncReplica(client, { clientId: 'client-a' })
	const sourceStorage = nodeMemStorage()
	const source = memoryNodeReplica(sourceStorage)
	const sourceVolume = volume(sourceStorage)
	await sourceVolume.mkdir('/docs')
	await sourceVolume.writeFile('/docs/note.md', bytes('hello'))

	const outgoing = await source.nodeDeltas('', { limit: 100 })
	await remote.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash))
	expect((await sourceVolume.lstat('/docs/note.md')).ino).not.toBe(
		(await volume(server.storage).lstat('/docs/note.md')).ino
	)
	expect(
		(await remote.nodeDeltas('', { excludeLocalSource: 'client-a', limit: 100 })).operations
	).toEqual([])

	const targetStorage = nodeMemStorage()
	const target = memoryNodeReplica(targetStorage)
	let pageToken: string | undefined
	let session: string | undefined
	do {
		const page = await remote.nodeSnapshot(pageToken, { limit: 1 })
		if (page.status !== 'ok') throw new Error(page.status)
		session = page.session
		await target.applyNodeOperations(page.operations, async (hash) => {
			const blob = await remote.getSnapshotBlob(page.session, hash)
			if (blob.status !== 'ok') throw new Error(blob.status)
			return blob.data
		})
		pageToken = page.next
	} while (pageToken)
	if (!session) throw new Error('missing snapshot session')
	await remote.closeSnapshot(session)

	expect(text(await volume(targetStorage).readFile('/docs/note.md'))).toBe('hello')
	server.db.close()
})

test('HTTP moves 4,000 descendants with one mutation, one row, and no blob upload', async () => {
	const sql: string[] = []
	const requests: string[] = []
	const server = openSqlite(':memory:', true, sql)
	const remote = remoteNodeSyncReplica(wireClient(createFsApi(server.storage), requests), {
		clientId: 'client-a'
	})
	const sourceStorage = nodeMemStorage()
	const source = memoryNodeReplica(sourceStorage)
	const sourceVolume = volume(sourceStorage)
	await sourceVolume.mkdir('/old/tree', { recursive: true })
	await sourceVolume.mkdir('/new')
	for (let index = 0; index < 4000; index++)
		await sourceVolume.writeFile(`/old/tree/f${index}.txt`, bytes('same'))

	let outgoing = await source.nodeDeltas('', { limit: 10_000 })
	await remote.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash))
	const sourceCursor = outgoing.to
	const serverCursor = (await remote.nodeDeltas('', { limit: 10_000 })).to
	requests.length = 0
	sql.length = 0

	await sourceVolume.rename('/old/tree', '/new/tree')
	outgoing = await source.nodeDeltas(sourceCursor, { limit: 10 })
	expect(outgoing.operations).toHaveLength(1)
	expect(outgoing.operations[0]?.mutations).toEqual([
		expect.objectContaining({ kind: 'move', name: 'tree' })
	])
	await remote.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash))

	const accepted = await remote.nodeDeltas(serverCursor, { limit: 10 })
	expect(accepted.operations).toHaveLength(1)
	expect(accepted.operations[0]?.mutations).toEqual([
		expect.objectContaining({ kind: 'move', name: 'tree' })
	])
	expect(requests.filter((request) => request.startsWith('PUT /node/blob/'))).toEqual([])
	expect(sql.filter((statement) => /WITH\s+RECURSIVE/i.test(statement))).toEqual([])

	const targetStorage = nodeMemStorage()
	const target = memoryNodeReplica(targetStorage)
	let pageToken: string | undefined
	let session: string | undefined
	do {
		const page = await remote.nodeSnapshot(pageToken, { limit: 500 })
		if (page.status !== 'ok') throw new Error(page.status)
		session = page.session
		await target.applyNodeOperations(page.operations, async (hash) => {
			const blob = await remote.getSnapshotBlob(page.session, hash)
			if (blob.status !== 'ok') throw new Error(blob.status)
			return blob.data
		})
		pageToken = page.next
	} while (pageToken)
	if (!session) throw new Error('missing snapshot session')
	await remote.closeSnapshot(session)
	expect(text(await volume(targetStorage).readFile('/new/tree/f3999.txt'))).toBe('same')
	expect(await volume(targetStorage).exists('/old/tree')).toBe(false)
	server.db.close()
}, 30_000)

test('HTTP rejects an update with missing content, then accepts it under the same node ID', async () => {
	const server = openSqlite(':memory:')
	const app = createFsApi(server.storage)
	const remote = remoteNodeSyncReplica(wireClient(app), { clientId: 'client-a' })
	const sourceStorage = nodeMemStorage()
	const source = memoryNodeReplica(sourceStorage)
	const sourceVolume = volume(sourceStorage)
	await sourceVolume.writeFile('/note.txt', bytes('one'))
	let outgoing = await source.nodeDeltas('', { limit: 10 })
	await remote.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash))
	const cursor = outgoing.to
	const createdId = outgoing.operations[0]?.mutations[0]?.nodeId

	await sourceVolume.writeFile('/note.txt', bytes('two is longer'))
	outgoing = await source.nodeDeltas(cursor, { limit: 10 })
	const rejected = await app.request('/node/operations', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-fs-source': 'client-a' },
		body: JSON.stringify({ operations: outgoing.operations })
	})
	expect(rejected.status).toBe(409)
	expect(text(await volume(server.storage).readFile('/note.txt'))).toBe('one')

	await remote.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash))
	expect(text(await volume(server.storage).readFile('/note.txt'))).toBe('two is longer')
	const snapshot = await remote.nodeSnapshot(undefined, { limit: 10 })
	if (snapshot.status !== 'ok') throw new Error(snapshot.status)
	expect(snapshot.operations[0]?.mutations[0]?.nodeId).toBe(createdId)
	await remote.closeSnapshot(snapshot.session)
	server.db.close()
})

test('SQLite records user xattr changes in node state', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	const replica = nodeReplica(server.storage)
	await serverVolume.writeFile('/note.txt', bytes('note'))
	let cursor = (await replica.nodeDeltas('', { limit: 10 })).to

	await serverVolume.setXattr('/note.txt', 'user.label', bytes('tag'))
	let delta = await replica.nodeDeltas(cursor, { limit: 10 })
	let update = delta.operations.flatMap((operation) => operation.mutations)[0]
	if (update?.kind !== 'update') throw new Error('missing xattr update')
	expect(update.meta.xattrs).toEqual({ 'user.label': 'dGFn' })
	cursor = delta.to

	await serverVolume.setXattr('/note.txt', 'trusted.sync.local', bytes('private'))
	expect((await replica.nodeDeltas(cursor, { limit: 10 })).operations).toEqual([])

	await serverVolume.removeXattr('/note.txt', 'user.label')
	delta = await replica.nodeDeltas(cursor, { limit: 10 })
	update = delta.operations.flatMap((operation) => operation.mutations)[0]
	if (update?.kind !== 'update') throw new Error('missing xattr removal')
	expect(update.meta.xattrs).toBeUndefined()
	server.db.close()
})

test('SQLite putDirent keeps path-v1 insert-or-replace behavior for mapped inodes', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.writeFile('/source.txt', bytes('source'))
	await serverVolume.writeFile('/destination.txt', bytes('destination'))
	const source = await server.storage.getDirent(server.storage.rootIno, 'source.txt')
	if (!source) throw new Error('missing source')
	const cursor = await server.storage.sync.journal.head()

	await server.storage.putDirent(server.storage.rootIno, 'alias.txt', source)
	await server.storage.putDirent(server.storage.rootIno, 'destination.txt', source)

	const fresh = volume(server.storage)
	expect(text(await fresh.readFile('/alias.txt'))).toBe('source')
	expect(text(await fresh.readFile('/destination.txt'))).toBe('source')
	expect(
		(await server.storage.sync.journal.readFrom(cursor, 10)).map((row) => row.change.path).sort()
	).toEqual(['/alias.txt', '/destination.txt'])
	server.db.close()
})

test('SQLite node sync eagerly materializes bytes when caps.content is hidden', async () => {
	const server = openSqlite(':memory:')
	const { content: _content, ...caps } = server.storage.caps
	const serverWithoutContent = { ...server.storage, caps }
	const remote = remoteNodeSyncReplica(wireClient(createFsApi(serverWithoutContent)), {
		clientId: 'client-a'
	})
	const sourceStorage = nodeMemStorage()
	const source = memoryNodeReplica(sourceStorage)
	await volume(sourceStorage).writeFile('/note.txt', bytes('ordinary bytes'))
	const outgoing = await source.nodeDeltas('', { limit: 10 })

	await remote.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash))

	expect(text(await volume(server.storage).readFile('/note.txt'))).toBe('ordinary bytes')
	server.db.close()
})

test('a deleted SQLite node stays tombstoned after restart and path reuse gets a new ID', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'justfiles-node-delete-'))
	temporaryDirectories.push(directory)
	const filename = join(directory, 'fs.db')
	const firstServer = openSqlite(filename)
	let remote = remoteNodeSyncReplica(wireClient(createFsApi(firstServer.storage)), {
		clientId: 'client-a'
	})
	const sourceStorage = nodeMemStorage()
	const source = memoryNodeReplica(sourceStorage)
	const sourceVolume = volume(sourceStorage)
	await sourceVolume.writeFile('/note.txt', bytes('old'))
	let outgoing = await source.nodeDeltas('', { limit: 10 })
	const oldId = outgoing.operations[0]?.mutations[0]?.nodeId
	if (!oldId) throw new Error('missing old node ID')
	await remote.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash))
	let sourceCursor = outgoing.to

	await sourceVolume.rm('/note.txt')
	outgoing = await source.nodeDeltas(sourceCursor, { limit: 10 })
	await remote.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash))
	sourceCursor = outgoing.to
	firstServer.db.close()

	const secondServer = openSqlite(filename, false)
	remote = remoteNodeSyncReplica(wireClient(createFsApi(secondServer.storage)), {
		clientId: 'client-a'
	})
	await remote.applyNodeOperations(
		[
			{
				mutations: [
					{
						kind: 'create',
						nodeId: oldId,
						parentId: ROOT_NODE_ID,
						name: 'forbidden',
						revision: 1,
						meta: { type: 1, mode: 0o755, mtimeNs: '0', size: '0' }
					}
				]
			}
		],
		() => Promise.reject(new Error('directory create requested content'))
	)
	expect(await volume(secondServer.storage).exists('/forbidden')).toBe(false)

	await sourceVolume.writeFile('/note.txt', bytes('new'))
	outgoing = await source.nodeDeltas(sourceCursor, { limit: 10 })
	const newId = outgoing.operations[0]?.mutations[0]?.nodeId
	expect(newId).toBeTruthy()
	expect(newId).not.toBe(oldId)
	await remote.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash))
	expect(text(await volume(secondServer.storage).readFile('/note.txt'))).toBe('new')
	secondServer.db.close()
})

test('SQLite rolls back filesystem, identity, and journal writes together', async () => {
	const failure = { enabled: false }
	const server = openSqlite(':memory:', true, undefined, failure)
	const serverVolume = volume(server.storage)
	const replica = nodeReplica(server.storage)
	await serverVolume.mkdir('/source')
	await serverVolume.mkdir('/target')
	await serverVolume.writeFile('/delete.txt', bytes('delete'))
	const cursor = (await replica.nodeDeltas('', { limit: 100 })).to

	failure.enabled = true
	await expect(serverVolume.mkdir('/rolled-back')).rejects.toThrow('injected node journal failure')
	failure.enabled = false
	expect(await volume(server.storage).exists('/rolled-back')).toBe(false)
	let page = await replica.nodeDeltas(cursor, { limit: 100 })
	expect(page.operations).toEqual([])
	expect(page.to).toBe(cursor)

	failure.enabled = true
	await expect(serverVolume.rename('/source', '/target/moved')).rejects.toThrow(
		'injected node journal failure'
	)
	failure.enabled = false
	expect(await volume(server.storage).exists('/source')).toBe(true)
	expect(await volume(server.storage).exists('/target/moved')).toBe(false)
	page = await replica.nodeDeltas(cursor, { limit: 100 })
	expect(page.operations).toEqual([])
	expect(page.to).toBe(cursor)

	failure.enabled = true
	await expect(serverVolume.rm('/delete.txt')).rejects.toThrow('injected node journal failure')
	failure.enabled = false
	expect(text(await volume(server.storage).readFile('/delete.txt'))).toBe('delete')
	page = await replica.nodeDeltas(cursor, { limit: 100 })
	expect(page.operations).toEqual([])
	expect(page.to).toBe(cursor)
	server.db.close()
})

test('HTTP snapshot paging hands off to deltas at its frozen SQLite high-water', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.writeFile('/a.txt', bytes('a'))
	await serverVolume.writeFile('/b.txt', bytes('b'))
	const remote = remoteNodeSyncReplica(wireClient(createFsApi(server.storage)), {
		clientId: 'client-a'
	})
	const targetStorage = nodeMemStorage()
	const target = memoryNodeReplica(targetStorage)
	const first = await remote.nodeSnapshot(undefined, { limit: 1 })
	if (first.status !== 'ok' || !first.next) throw new Error('missing first snapshot page')
	const frozenCursor = first.syncCursor
	await target.applyNodeOperations(first.operations, async (hash) => {
		const blob = await remote.getSnapshotBlob(first.session, hash)
		if (blob.status !== 'ok') throw new Error(blob.status)
		return blob.data
	})

	await serverVolume.writeFile('/later.txt', bytes('later'))
	let pageToken: string | undefined = first.next
	while (pageToken) {
		const page = await remote.nodeSnapshot(pageToken, { limit: 1 })
		if (page.status !== 'ok') throw new Error(page.status)
		await target.applyNodeOperations(page.operations, async (hash) => {
			const blob = await remote.getSnapshotBlob(page.session, hash)
			if (blob.status !== 'ok') throw new Error(blob.status)
			return blob.data
		})
		pageToken = page.next
	}
	await remote.closeSnapshot(first.session)

	const delta = await remote.nodeDeltas(frozenCursor, { limit: 10 })
	expect(delta.operations).toHaveLength(1)
	await target.applyNodeOperations(delta.operations, (hash) => remote.getBlobByHash(hash))
	const targetVolume = volume(targetStorage)
	expect(text(await targetVolume.readFile('/a.txt'))).toBe('a')
	expect(text(await targetVolume.readFile('/b.txt'))).toBe('b')
	expect(text(await targetVolume.readFile('/later.txt'))).toBe('later')
	expect((await targetVolume.readdir('/')).map((entry) => entry.name).sort()).toEqual([
		'a.txt',
		'b.txt',
		'later.txt'
	])
	server.db.close()
})

test('a lagging HTTP client skips SQLite content superseded before delivery', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.writeFile('/note.txt', bytes('one'))
	await serverVolume.writeFile('/note.txt', bytes('two'))
	await serverVolume.writeFile('/note.txt', bytes('three'))
	const remote = remoteNodeSyncReplica(wireClient(createFsApi(server.storage)), {
		clientId: 'client-a'
	})
	const targetStorage = nodeMemStorage()
	const target = memoryNodeReplica(targetStorage)

	const delta = await remote.nodeDeltas('', { limit: 10 })
	await target.applyNodeOperations(delta.operations, (hash) => remote.getBlobByHash(hash))

	expect(text(await volume(targetStorage).readFile('/note.txt'))).toBe('three')
	server.db.close()
})

test('HTTP retries do not fetch content or append SQLite node rows again', async () => {
	const server = openSqlite(':memory:')
	const remote = remoteNodeSyncReplica(wireClient(createFsApi(server.storage)), {
		clientId: 'client-a'
	})
	const sourceStorage = nodeMemStorage()
	const source = memoryNodeReplica(sourceStorage)
	const sourceVolume = volume(sourceStorage)
	await sourceVolume.mkdir('/a')
	await sourceVolume.mkdir('/b')
	await sourceVolume.writeFile('/a/note.txt', bytes('one'))
	await sourceVolume.writeFile('/a/note.txt', bytes('two'))
	await sourceVolume.rename('/a/note.txt', '/b/note.txt')
	await sourceVolume.writeFile('/a/deleted.txt', bytes('deleted'))
	await sourceVolume.rm('/a/deleted.txt')
	const outgoing = await source.nodeDeltas('', { limit: 100 })
	await remote.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash))
	const cursor = (await remote.nodeDeltas('', { limit: 100 })).to

	await remote.applyNodeOperations(outgoing.operations, () =>
		Promise.reject(new Error('retry requested content'))
	)

	const retryDelta = await remote.nodeDeltas(cursor, { limit: 100 })
	expect(retryDelta.operations).toEqual([])
	const serverVolume = volume(server.storage)
	expect(text(await serverVolume.readFile('/b/note.txt'))).toBe('two')
	expect(await serverVolume.exists('/a/note.txt')).toBe(false)
	expect(await serverVolume.exists('/a/deleted.txt')).toBe(false)
	server.db.close()
})
