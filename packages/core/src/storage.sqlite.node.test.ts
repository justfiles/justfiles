import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { volume } from '@justfiles/fs'
import { storageSyncReplica } from '@justfiles/sync'
import { type NodeMutation, NodeOperationRejectedError, ROOT_NODE_ID } from '@justfiles/sync/node'
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

function findCreate(mutations: NodeMutation[], name: string) {
	const mutation = mutations.find(
		(item): item is Extract<NodeMutation, { kind: 'create' }> =>
			item.kind === 'create' && item.name === name
	)
	if (!mutation) throw new Error(`missing ${name}`)
	return mutation
}

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
				operationId: 'client-docs-create',
				mutations: [
					{
						kind: 'create',
						nodeId: 'client-docs',
						parentId: ROOT_NODE_ID,
						name: 'docs',
						baseRevision: 0,
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

test('HTTP node authority returns an exact create retry and rejects changed reuse', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'justfiles-node-operation-'))
	temporaryDirectories.push(directory)
	const filename = join(directory, 'fs.db')
	let server = openSqlite(filename)
	let app = createFsApi(server.storage, { actor: () => 'authenticated-user' })
	const request = {
		operations: [
			{
				operationId: 'create-docs',
				origin: 'forged-user',
				mutations: [
					{
						kind: 'create',
						nodeId: 'docs-id',
						parentId: ROOT_NODE_ID,
						name: 'docs',
						baseRevision: 0,
						revision: 1,
						meta: { type: 1, mode: 0o755, mtimeNs: '0', size: '0' }
					}
				]
			}
		]
	}
	const send = (body: unknown) =>
		app.request('/node/operations', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-fs-source': 'client-a' },
			body: JSON.stringify(body)
		})

	const first = await send(request)
	expect(first.status).toBe(200)
	const accepted = await first.json()
	expect(accepted).toMatchObject({
		results: [{ status: 'accepted', operation: { origin: 'authenticated-user' } }]
	})
	server.db.close()
	server = openSqlite(filename, false)
	app = createFsApi(server.storage, { actor: () => 'authenticated-user' })
	const retryRequest = structuredClone(request)
	retryRequest.operations[0]!.origin = 'another-forged-user'
	const retry = await send(retryRequest)
	expect(retry.status).toBe(200)
	expect(await retry.json()).toEqual(accepted)

	const changed = structuredClone(request)
	changed.operations[0]!.mutations[0]!.name = 'other'
	const rejected = await send(changed)
	expect(rejected.status).toBe(409)
	expect(await rejected.json()).toMatchObject({
		results: [{ status: 'rejected', reason: 'invalid', operationId: 'create-docs' }]
	})

	const delta = await nodeReplica(server.storage).nodeDeltas('', { limit: 10 })
	expect(delta.operations).toHaveLength(1)
	expect(delta.operations[0]?.mutations).toEqual([
		expect.objectContaining({ nodeId: 'docs-id', revision: 1 })
	])
	expect(delta.operations[0]?.origin).toBe('authenticated-user')
	expect((await volume(server.storage).readdir('/')).map((entry) => entry.name)).toEqual(['docs'])
	server.db.close()
})

test('HTTP node authority lets the first concurrent move win', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.mkdir('/a')
	await serverVolume.mkdir('/b')
	await serverVolume.writeFile('/note.txt', bytes('note'))
	const remote = remoteNodeSyncReplica(wireClient(createFsApi(server.storage)), {
		clientId: 'client-a'
	})
	const snapshot = await remote.nodeSnapshot(undefined, { limit: 10 })
	if (snapshot.status !== 'ok') throw new Error(snapshot.status)
	const creates = snapshot.operations.flatMap((operation) => operation.mutations)
	const a = creates.find((mutation) => mutation.kind === 'create' && mutation.name === 'a')
	const b = creates.find((mutation) => mutation.kind === 'create' && mutation.name === 'b')
	const note = creates.find(
		(mutation) => mutation.kind === 'create' && mutation.name === 'note.txt'
	)
	if (!a || !b || !note) throw new Error('missing snapshot nodes')
	await remote.closeSnapshot(snapshot.session)
	const move = (operationId: string, parentId: string) => ({
		operationId,
		mutations: [
			{
				kind: 'move' as const,
				nodeId: note.nodeId,
				parentId,
				name: 'note.txt',
				baseRevision: note.revision,
				revision: note.revision + 1
			}
		]
	})

	await remote.applyNodeOperations([move('move-a', a.nodeId)], () =>
		Promise.reject(new Error('move requested content'))
	)
	await expect(
		remote.applyNodeOperations([move('move-b', b.nodeId)], () =>
			Promise.reject(new Error('move requested content'))
		)
	).rejects.toMatchObject({
		name: NodeOperationRejectedError.name,
		result: {
			status: 'rejected',
			reason: 'stale',
			current: { id: note.nodeId, parentId: a.nodeId, name: 'note.txt', revision: 2 }
		}
	})
	expect(text(await serverVolume.readFile('/a/note.txt'))).toBe('note')
	expect(await serverVolume.exists('/b/note.txt')).toBe(false)
	expect(await serverVolume.exists('/note.txt')).toBe(false)
	server.db.close()
})

test('a stale local move stays pending after HTTP rejection', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.mkdir('/a')
	await serverVolume.mkdir('/b')
	await serverVolume.writeFile('/note.txt', bytes('note'))
	const remote = remoteNodeSyncReplica(wireClient(createFsApi(server.storage)), {
		clientId: 'client'
	})
	const clients = [nodeMemStorage(), nodeMemStorage()]
	for (const storage of clients) {
		const target = memoryNodeReplica(storage)
		const snapshot = await remote.nodeSnapshot(undefined, { limit: 10 })
		if (snapshot.status !== 'ok') throw new Error(snapshot.status)
		await target.applyNodeOperations(
			snapshot.operations,
			async (hash) => {
				const blob = await remote.getSnapshotBlob(snapshot.session, hash)
				if (blob.status !== 'ok') throw new Error(blob.status)
				return blob.data
			},
			{ source: 'server' }
		)
		await remote.closeSnapshot(snapshot.session)
	}
	const [firstStorage, staleStorage] = clients
	if (!firstStorage || !staleStorage) throw new Error('missing clients')
	const first = memoryNodeReplica(firstStorage)
	const stale = memoryNodeReplica(staleStorage)
	const firstCursor = (await first.nodeDeltas('', { excludeLocalSource: 'server', limit: 10 })).to
	const staleCursor = (await stale.nodeDeltas('', { excludeLocalSource: 'server', limit: 10 })).to
	await volume(firstStorage).rename('/note.txt', '/a/note.txt')
	await volume(staleStorage).rename('/note.txt', '/b/note.txt')
	const firstMove = await first.nodeDeltas(firstCursor, {
		excludeLocalSource: 'server',
		limit: 10
	})
	const staleMove = await stale.nodeDeltas(staleCursor, {
		excludeLocalSource: 'server',
		limit: 10
	})

	await remote.applyNodeOperations(firstMove.operations, () =>
		Promise.reject(new Error('move requested content'))
	)
	await expect(
		remote.applyNodeOperations(staleMove.operations, () =>
			Promise.reject(new Error('move requested content'))
		)
	).rejects.toMatchObject({ result: { reason: 'stale', current: { name: 'note.txt' } } })
	const stillPending = await stale.nodeDeltas(staleCursor, {
		excludeLocalSource: 'server',
		limit: 10
	})
	expect(stillPending.operations).toEqual(staleMove.operations)
	expect(text(await serverVolume.readFile('/a/note.txt'))).toBe('note')
	expect(await serverVolume.exists('/b/note.txt')).toBe(false)
	server.db.close()
})

test('HTTP node authority orders move and delete by one revision', async () => {
	for (const first of ['move', 'delete'] as const) {
		const server = openSqlite(':memory:')
		const serverVolume = volume(server.storage)
		await serverVolume.mkdir('/target')
		await serverVolume.writeFile('/note.txt', bytes('note'))
		const remote = remoteNodeSyncReplica(wireClient(createFsApi(server.storage)), {
			clientId: `client-${first}`
		})
		const snapshot = await remote.nodeSnapshot(undefined, { limit: 10 })
		if (snapshot.status !== 'ok') throw new Error(snapshot.status)
		const creates = snapshot.operations.flatMap((operation) => operation.mutations)
		const target = creates.find(
			(mutation) => mutation.kind === 'create' && mutation.name === 'target'
		)
		const note = creates.find(
			(mutation) => mutation.kind === 'create' && mutation.name === 'note.txt'
		)
		if (!target || !note) throw new Error('missing snapshot nodes')
		await remote.closeSnapshot(snapshot.session)
		const move = {
			operationId: `${first}-move`,
			mutations: [
				{
					kind: 'move' as const,
					nodeId: note.nodeId,
					parentId: target.nodeId,
					name: 'note.txt',
					baseRevision: note.revision,
					revision: note.revision + 1
				}
			]
		}
		const remove = {
			operationId: `${first}-delete`,
			mutations: [
				{
					kind: 'delete' as const,
					nodeId: note.nodeId,
					baseRevision: note.revision,
					revision: note.revision + 1
				}
			]
		}
		const before = (await remote.nodeDeltas('', { limit: 10 })).to
		const firstOperation = first === 'move' ? move : remove
		const secondOperation = first === 'move' ? remove : move

		await remote.applyNodeOperations([firstOperation], () =>
			Promise.reject(new Error('move/delete requested content'))
		)
		await expect(
			remote.applyNodeOperations([secondOperation], () =>
				Promise.reject(new Error('move/delete requested content'))
			)
		).rejects.toBeInstanceOf(NodeOperationRejectedError)
		expect((await remote.nodeDeltas(before, { limit: 10 })).operations).toHaveLength(1)
		if (first === 'move') {
			expect(text(await serverVolume.readFile('/target/note.txt'))).toBe('note')
			expect(await serverVolume.exists('/note.txt')).toBe(false)
		} else {
			expect(await serverVolume.exists('/note.txt')).toBe(false)
			expect(await serverVolume.exists('/target/note.txt')).toBe(false)
		}
		server.db.close()
	}
})

test('HTTP node authority rejects an occupied destination without changing either node', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.writeFile('/source.txt', bytes('source'))
	await serverVolume.writeFile('/target.txt', bytes('target'))
	const remote = remoteNodeSyncReplica(wireClient(createFsApi(server.storage)), {
		clientId: 'client-a'
	})
	const snapshot = await remote.nodeSnapshot(undefined, { limit: 10 })
	if (snapshot.status !== 'ok') throw new Error(snapshot.status)
	const creates = snapshot.operations.flatMap((operation) => operation.mutations)
	const source = creates.find(
		(mutation) => mutation.kind === 'create' && mutation.name === 'source.txt'
	)
	const target = creates.find(
		(mutation) => mutation.kind === 'create' && mutation.name === 'target.txt'
	)
	if (!source || !target) throw new Error('missing snapshot nodes')
	await remote.closeSnapshot(snapshot.session)
	const move = (operationId: string, baseRevision: number) => ({
		operationId,
		mutations: [
			{
				kind: 'move' as const,
				nodeId: source.nodeId,
				parentId: ROOT_NODE_ID,
				name: 'target.txt',
				baseRevision,
				revision: baseRevision + 1
			}
		]
	})
	const before = (await remote.nodeDeltas('', { limit: 10 })).to

	await expect(
		remote.applyNodeOperations([move('move-collision', source.revision)], () =>
			Promise.reject(new Error('move requested content'))
		)
	).rejects.toMatchObject({
		result: {
			status: 'rejected',
			reason: 'collision',
			occupant: { id: target.nodeId, name: 'target.txt' }
		}
	})
	expect((await remote.nodeDeltas(before, { limit: 10 })).operations).toEqual([])
	expect(text(await serverVolume.readFile('/source.txt'))).toBe('source')
	expect(text(await serverVolume.readFile('/target.txt'))).toBe('target')

	await serverVolume.setXattr('/source.txt', 'user.changed', bytes('1'))
	await remote.applyNodeOperations(
		[
			{
				operationId: 'delete-target',
				mutations: [
					{
						kind: 'delete',
						nodeId: target.nodeId,
						baseRevision: target.revision,
						revision: target.revision + 1
					}
				]
			}
		],
		() => Promise.reject(new Error('delete requested content'))
	)
	await expect(
		remote.applyNodeOperations([move('move-stale', source.revision)], () =>
			Promise.reject(new Error('move requested content'))
		)
	).rejects.toMatchObject({ result: { reason: 'stale', current: { revision: 2 } } })
	await remote.applyNodeOperations([move('move-rebased', 2)], () =>
		Promise.reject(new Error('move requested content'))
	)
	expect(text(await serverVolume.readFile('/target.txt'))).toBe('source')
	expect(await serverVolume.exists('/source.txt')).toBe(false)
	server.db.close()
})

test('HTTP node authority rejects directory cycles and keeps the tree reachable after restart', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'justfiles-node-cycle-'))
	temporaryDirectories.push(directory)
	const filename = join(directory, 'fs.db')
	const server = openSqlite(filename)
	const serverVolume = volume(server.storage)
	await serverVolume.mkdir('/A/B/C', { recursive: true })
	const remote = remoteNodeSyncReplica(wireClient(createFsApi(server.storage)), {
		clientId: 'client-a'
	})
	const snapshot = await remote.nodeSnapshot(undefined, { limit: 10 })
	if (snapshot.status !== 'ok') throw new Error(snapshot.status)
	const creates = snapshot.operations.flatMap((operation) => operation.mutations)
	const a = creates.find((mutation) => mutation.kind === 'create' && mutation.name === 'A')
	const b = creates.find((mutation) => mutation.kind === 'create' && mutation.name === 'B')
	const c = creates.find((mutation) => mutation.kind === 'create' && mutation.name === 'C')
	if (!a || !b || !c) throw new Error('missing snapshot nodes')
	await remote.closeSnapshot(snapshot.session)
	const before = (await remote.nodeDeltas('', { limit: 10 })).to
	const move = (operationId: string, nodeId: string, parentId: string, revision: number) => ({
		operationId,
		mutations: [
			{
				kind: 'move' as const,
				nodeId,
				parentId,
				name: nodeId === a.nodeId ? 'A' : 'B',
				baseRevision: revision,
				revision: revision + 1
			}
		]
	})

	await expect(
		remote.applyNodeOperations([move('cycle-a', a.nodeId, c.nodeId, a.revision)], () =>
			Promise.reject(new Error('move requested content'))
		)
	).rejects.toMatchObject({ result: { reason: 'cycle' } })
	await expect(
		remote.applyNodeOperations([move('cycle-b', b.nodeId, b.nodeId, b.revision)], () =>
			Promise.reject(new Error('move requested content'))
		)
	).rejects.toMatchObject({ result: { reason: 'cycle' } })
	expect((await remote.nodeDeltas(before, { limit: 10 })).operations).toEqual([])
	server.db.close()

	const restarted = openSqlite(filename, false)
	expect(await volume(restarted.storage).exists('/A/B/C')).toBe(true)
	expect((await volume(restarted.storage).readdir('/A/B')).map((entry) => entry.name)).toEqual([
		'C'
	])
	restarted.db.close()
})

test('HTTP node authority validates parents and names and protects the root', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.mkdir('/live')
	await serverVolume.mkdir('/dead')
	await serverVolume.writeFile('/file', bytes('file'))
	await serverVolume.symlink('/file', '/link')
	await serverVolume.writeFile('/source', bytes('source'))
	const remote = remoteNodeSyncReplica(wireClient(createFsApi(server.storage)), {
		clientId: 'client-a'
	})
	const snapshot = await remote.nodeSnapshot(undefined, { limit: 10 })
	if (snapshot.status !== 'ok') throw new Error(snapshot.status)
	const creates = snapshot.operations.flatMap((operation) => operation.mutations)
	const node = (name: string) => {
		const found = creates.find((mutation) => mutation.kind === 'create' && mutation.name === name)
		if (!found) throw new Error(`missing ${name}`)
		return found
	}
	const live = node('live')
	const dead = node('dead')
	const file = node('file')
	const link = node('link')
	const source = node('source')
	await remote.closeSnapshot(snapshot.session)
	await serverVolume.rm('/dead')
	const before = (await remote.nodeDeltas('', { limit: 20 })).to
	let count = 0
	const move = (
		parentId: string,
		name: string,
		nodeId = source.nodeId,
		revision = source.revision
	) => ({
		operationId: `invalid-move-${++count}`,
		mutations: [
			{
				kind: 'move' as const,
				nodeId,
				parentId,
				name,
				baseRevision: revision,
				revision: revision + 1
			}
		]
	})
	const rejects = async (operation: ReturnType<typeof move>, reason: string) => {
		await expect(
			remote.applyNodeOperations([operation], () =>
				Promise.reject(new Error('move requested content'))
			)
		).rejects.toMatchObject({ result: { status: 'rejected', reason } })
	}

	for (const [parentId, issue] of [
		['missing-parent', 'missing'],
		[dead.nodeId, 'deleted'],
		[file.nodeId, 'not_directory'],
		[link.nodeId, 'not_directory']
	] as const)
		await expect(
			remote.applyNodeOperations([move(parentId, 'source')], () =>
				Promise.reject(new Error('move requested content'))
			)
		).rejects.toMatchObject({
			result: { status: 'rejected', reason: 'invalid_parent', issue }
		})

	for (const name of ['', 'a/b', '.', '..', 'e\u0301'])
		await rejects(move(live.nodeId, name), 'invalid_name')

	await remote.applyNodeOperations([move(ROOT_NODE_ID, 'source')], () =>
		Promise.reject(new Error('move requested content'))
	)
	await rejects(move(live.nodeId, 'root', ROOT_NODE_ID, 0), 'invalid')
	await expect(
		remote.applyNodeOperations(
			[
				{
					operationId: 'delete-root',
					mutations: [{ kind: 'delete', nodeId: ROOT_NODE_ID, baseRevision: 0, revision: 1 }]
				}
			],
			() => Promise.reject(new Error('delete requested content'))
		)
	).rejects.toMatchObject({ result: { reason: 'invalid' } })

	expect((await remote.nodeDeltas(before, { limit: 20 })).operations).toEqual([])
	expect(text(await serverVolume.readFile('/source'))).toBe('source')
	expect((await serverVolume.readdir('/live')).map((entry) => entry.name)).toEqual([])
	server.db.close()
})

test('HTTP node authority rejects a non-empty directory and accepts child-first deletes', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.mkdir('/tree/sub', { recursive: true })
	await serverVolume.writeFile('/tree/sub/file', bytes('file'))
	const remote = remoteNodeSyncReplica(wireClient(createFsApi(server.storage)), {
		clientId: 'client-a'
	})
	const snapshot = await remote.nodeSnapshot(undefined, { limit: 10 })
	if (snapshot.status !== 'ok') throw new Error(snapshot.status)
	const creates = snapshot.operations.flatMap((operation) => operation.mutations)
	const node = (name: string) => {
		const found = creates.find((mutation) => mutation.kind === 'create' && mutation.name === name)
		if (!found) throw new Error(`missing ${name}`)
		return found
	}
	const tree = node('tree')
	const sub = node('sub')
	const file = node('file')
	await remote.closeSnapshot(snapshot.session)
	const remove = (operationId: string, target: typeof tree) => ({
		operationId,
		mutations: [
			{
				kind: 'delete' as const,
				nodeId: target.nodeId,
				baseRevision: target.revision,
				revision: target.revision + 1
			}
		]
	})
	const before = (await remote.nodeDeltas('', { limit: 10 })).to

	await expect(
		remote.applyNodeOperations([remove('delete-tree-early', tree)], () =>
			Promise.reject(new Error('delete requested content'))
		)
	).rejects.toMatchObject({ result: { reason: 'not_empty' } })
	expect((await remote.nodeDeltas(before, { limit: 10 })).operations).toEqual([])
	expect(await serverVolume.exists('/tree/sub/file')).toBe(true)

	for (const [operationId, target] of [
		['delete-file', file],
		['delete-sub', sub],
		['delete-tree', tree]
	] as const)
		await remote.applyNodeOperations([remove(operationId, target)], () =>
			Promise.reject(new Error('delete requested content'))
		)
	const accepted = await remote.nodeDeltas(before, { limit: 10 })
	expect(accepted.operations.map((operation) => operation.mutations[0]?.nodeId)).toEqual([
		file.nodeId,
		sub.nodeId,
		tree.nodeId
	])
	expect(await serverVolume.exists('/tree')).toBe(false)
	server.db.close()
})

test('HTTP node authority keeps tombstone identity and releases only the name', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.mkdir('/gone')
	const remote = remoteNodeSyncReplica(wireClient(createFsApi(server.storage)), {
		clientId: 'client-a'
	})
	const snapshot = await remote.nodeSnapshot(undefined, { limit: 10 })
	if (snapshot.status !== 'ok') throw new Error(snapshot.status)
	const gone = findCreate(
		snapshot.operations.flatMap((operation) => operation.mutations),
		'gone'
	)
	await remote.closeSnapshot(snapshot.session)
	const remove = {
		operationId: 'delete-gone',
		mutations: [
			{
				kind: 'delete' as const,
				nodeId: gone.nodeId,
				baseRevision: gone.revision,
				revision: gone.revision + 1
			}
		]
	}
	const before = (await remote.nodeDeltas('', { limit: 10 })).to
	const accepted = await remote.applyNodeOperations([remove], () =>
		Promise.reject(new Error('delete requested content'))
	)
	expect(
		await remote.applyNodeOperations([remove], () =>
			Promise.reject(new Error('delete requested content'))
		)
	).toEqual(accepted)
	expect((await remote.nodeDeltas(before, { limit: 10 })).operations).toHaveLength(1)

	const deletedRevision = gone.revision + 1
	const rejected = [
		{
			operationId: 'update-gone',
			mutations: [
				{
					kind: 'update' as const,
					nodeId: gone.nodeId,
					baseRevision: deletedRevision,
					revision: deletedRevision + 1,
					meta: gone.meta
				}
			]
		},
		{
			operationId: 'move-gone',
			mutations: [
				{
					kind: 'move' as const,
					nodeId: gone.nodeId,
					parentId: ROOT_NODE_ID,
					name: 'moved',
					baseRevision: deletedRevision,
					revision: deletedRevision + 1
				}
			]
		},
		{
			operationId: 'delete-gone-again',
			mutations: [
				{
					kind: 'delete' as const,
					nodeId: gone.nodeId,
					baseRevision: deletedRevision,
					revision: deletedRevision + 1
				}
			]
		},
		{
			operationId: 'create-gone-again',
			mutations: [
				{
					kind: 'create' as const,
					nodeId: gone.nodeId,
					parentId: ROOT_NODE_ID,
					name: 'gone',
					baseRevision: 0 as const,
					revision: 1,
					meta: gone.meta
				}
			]
		}
	]
	for (const operation of rejected)
		await expect(
			remote.applyNodeOperations([operation], () =>
				Promise.reject(new Error('deleted node requested content'))
			)
		).rejects.toMatchObject({
			result: { reason: 'deleted', current: { id: gone.nodeId, revision: deletedRevision } }
		})

	await remote.applyNodeOperations(
		[
			{
				operationId: 'create-replacement',
				mutations: [
					{
						kind: 'create',
						nodeId: 'replacement-id',
						parentId: ROOT_NODE_ID,
						name: 'gone',
						baseRevision: 0,
						revision: 1,
						meta: gone.meta
					}
				]
			}
		],
		() => Promise.reject(new Error('directory create requested content'))
	)
	expect(await serverVolume.exists('/gone')).toBe(true)
	const current = await remote.nodeSnapshot(undefined, { limit: 10 })
	if (current.status !== 'ok') throw new Error(current.status)
	expect(current.operations.flatMap((operation) => operation.mutations)).toContainEqual(
		expect.objectContaining({ nodeId: 'replacement-id', name: 'gone' })
	)
	await remote.closeSnapshot(current.session)
	server.db.close()
})

test('HTTP node authority rejects bad content and fences before operation identity', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.writeFile('/note.txt', bytes('old'))
	const lineage = { generation: 5, lineageId: 'volume-a' }
	const app = createFsApi(server.storage, { lineage: () => lineage })
	const client = wireClient(app)
	const currentRemote = remoteNodeSyncReplica(client, {
		clientId: 'client-current',
		generation: () => lineage.generation,
		lineageId: () => lineage.lineageId
	})
	const snapshot = await currentRemote.nodeSnapshot(undefined, { limit: 10 })
	if (snapshot.status !== 'ok') throw new Error(snapshot.status)
	const note = findCreate(
		snapshot.operations.flatMap((operation) => operation.mutations),
		'note.txt'
	)
	if (!note.contentHash) throw new Error('missing note hash')
	await currentRemote.closeSnapshot(snapshot.session)
	const before = (await currentRemote.nodeDeltas('', { limit: 10 })).to
	const missingHash = 'f'.repeat(64)
	const send = (operation: unknown, headers?: Record<string, string>) =>
		app.request('/node/operations', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify({ operations: [operation] })
		})
	const missingContent = {
		operationId: 'missing-content',
		mutations: [
			{
				kind: 'update',
				nodeId: note.nodeId,
				baseRevision: note.revision,
				revision: note.revision + 1,
				meta: { ...note.meta, size: '3' },
				contentHash: missingHash
			}
		]
	}
	const missing = await send(missingContent, {
		'x-fs-generation': '5',
		'x-fs-lineage': lineage.lineageId
	})
	expect(missing.status).toBe(409)
	expect(await missing.json()).toMatchObject({
		results: [{ status: 'rejected', reason: 'missing_content', operationId: 'missing-content' }]
	})

	const wrongType = {
		operationId: 'directory-content',
		mutations: [
			{
				kind: 'create',
				nodeId: 'directory-content-id',
				parentId: ROOT_NODE_ID,
				name: 'bad-directory',
				baseRevision: 0,
				revision: 1,
				meta: { type: 1, mode: 0o755, mtimeNs: '0', size: '0' },
				contentHash: note.contentHash
			}
		]
	}
	const wrong = await send(wrongType, {
		'x-fs-generation': '5',
		'x-fs-lineage': lineage.lineageId
	})
	expect(wrong.status).toBe(409)
	expect(await wrong.json()).toMatchObject({
		results: [{ status: 'rejected', reason: 'invalid_content' }]
	})
	const unknown = await send(
		{
			operationId: 'unknown-update',
			mutations: [
				{
					kind: 'update',
					nodeId: 'unknown-id',
					baseRevision: 1,
					revision: 2,
					meta: note.meta,
					contentHash: note.contentHash
				}
			]
		},
		{ 'x-fs-generation': '5', 'x-fs-lineage': lineage.lineageId }
	)
	expect(await unknown.json()).toMatchObject({
		results: [{ status: 'rejected', reason: 'not_found' }]
	})
	const changedType = await send(
		{
			operationId: 'changed-type',
			mutations: [
				{
					kind: 'update',
					nodeId: note.nodeId,
					baseRevision: note.revision,
					revision: note.revision + 1,
					meta: { ...note.meta, type: 1 }
				}
			]
		},
		{ 'x-fs-generation': '5', 'x-fs-lineage': lineage.lineageId }
	)
	expect(await changedType.json()).toMatchObject({
		results: [{ status: 'rejected', reason: 'invalid' }]
	})
	const hashless = await send(
		{
			operationId: 'missing-file-hash',
			mutations: [
				{
					kind: 'create',
					nodeId: 'missing-file-hash-id',
					parentId: ROOT_NODE_ID,
					name: 'missing-hash.txt',
					baseRevision: 0,
					revision: 1,
					meta: { type: 0, mode: 0o644, mtimeNs: '0', size: '0' }
				}
			]
		},
		{ 'x-fs-generation': '5', 'x-fs-lineage': lineage.lineageId }
	)
	expect(await hashless.json()).toMatchObject({
		results: [{ status: 'rejected', reason: 'invalid_content' }]
	})
	expect(text(await serverVolume.readFile('/note.txt'))).toBe('old')
	expect(await serverVolume.exists('/bad-directory')).toBe(false)
	expect((await currentRemote.nodeDeltas(before, { limit: 10 })).operations).toEqual([])

	const fencedCreate = (operationId: string, nodeId: string, name: string) => ({
		operationId,
		mutations: [
			{
				kind: 'create' as const,
				nodeId,
				parentId: ROOT_NODE_ID,
				name,
				baseRevision: 0 as const,
				revision: 1,
				meta: { type: 1 as const, mode: 0o755, mtimeNs: '0', size: '0' }
			}
		]
	})
	const staleOperation = fencedCreate('stale-generation-op', 'stale-generation-id', 'after-stale')
	const staleRemote = remoteNodeSyncReplica(client, {
		clientId: 'client-stale',
		generation: () => 4,
		lineageId: () => lineage.lineageId
	})
	await expect(
		staleRemote.applyNodeOperations([staleOperation], () =>
			Promise.reject(new Error('directory create requested content'))
		)
	).rejects.toMatchObject({ message: 'generation_stale' })
	await currentRemote.applyNodeOperations([staleOperation], () =>
		Promise.reject(new Error('directory create requested content'))
	)

	const wrongLineageOperation = fencedCreate(
		'wrong-lineage-op',
		'wrong-lineage-id',
		'after-lineage'
	)
	const wrongLineageRemote = remoteNodeSyncReplica(client, {
		clientId: 'client-wrong-lineage',
		generation: () => lineage.generation,
		lineageId: () => 'volume-b'
	})
	await expect(
		wrongLineageRemote.applyNodeOperations([wrongLineageOperation], () =>
			Promise.reject(new Error('directory create requested content'))
		)
	).rejects.toMatchObject({ message: 'lineage_stale' })
	await currentRemote.applyNodeOperations([wrongLineageOperation], () =>
		Promise.reject(new Error('directory create requested content'))
	)
	expect(await serverVolume.exists('/after-stale')).toBe(true)
	expect(await serverVolume.exists('/after-lineage')).toBe(true)
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
	await expect(
		remote.applyNodeOperations(
			[
				{
					operationId: 'reuse-deleted-id',
					mutations: [
						{
							kind: 'create',
							nodeId: oldId,
							parentId: ROOT_NODE_ID,
							name: 'forbidden',
							baseRevision: 0,
							revision: 1,
							meta: { type: 1, mode: 0o755, mtimeNs: '0', size: '0' }
						}
					]
				}
			],
			() => Promise.reject(new Error('directory create requested content'))
		)
	).rejects.toMatchObject({ result: { reason: 'deleted' } })
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
	let outgoing = await source.nodeDeltas('', { limit: 100 })
	const accepted = [...outgoing.operations]
	await remote.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash))
	let sourceCursor = outgoing.to

	await sourceVolume.writeFile('/a/deleted.txt', bytes('deleted'))
	outgoing = await source.nodeDeltas(sourceCursor, { limit: 100 })
	accepted.push(...outgoing.operations)
	await remote.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash))
	sourceCursor = outgoing.to

	await sourceVolume.rm('/a/deleted.txt')
	outgoing = await source.nodeDeltas(sourceCursor, { limit: 100 })
	accepted.push(...outgoing.operations)
	await remote.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash))
	const cursor = (await remote.nodeDeltas('', { limit: 100 })).to

	await remote.applyNodeOperations(accepted, () =>
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
