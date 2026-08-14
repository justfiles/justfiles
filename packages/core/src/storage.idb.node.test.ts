import 'fake-indexeddb/auto'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { volume } from '@justfiles/fs'
import { storageSyncReplica, synced } from '@justfiles/sync'
import { mutationsOf, type NodeReplica } from '@justfiles/sync/node'
import { idbStorage } from '@justfiles/sync/storage/idb'
import { expect, test, vi } from 'vitest'
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
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const text = (value: Uint8Array): string => new TextDecoder().decode(value)

function nodeReplica(storage: Parameters<typeof storageSyncReplica>[0]): NodeReplica {
	const selected = storageSyncReplica(storage)
	if (selected.strategy !== 'incremental') throw new Error('expected incremental sync')
	return selected.replica
}

function server(requests?: string[]) {
	const database = new DatabaseSync(':memory:')
	database.exec(schema)
	const adapter = createSqliteAdapter({
		prepare(sql: string) {
			const statement = database.prepare(sql)
			statement.setReadBigInts(true)
			return statement
		},
		exec: (sql: string) => database.exec(sql)
	} as Parameters<typeof createSqliteAdapter>[0])
	const storage = sqliteStorage(adapter)
	const app = createFsApi(storage)
	const client = createFsClient({
		baseUrl: 'http://node-sync.test',
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init)
			requests?.push(`${request.method} ${new URL(request.url).pathname}`)
			return app.request(request)
		}) as typeof fetch
	})
	return {
		database,
		storage,
		client,
		remote: remoteNodeSyncReplica(client, { clientId: 'idb-client' })
	}
}

test('an IndexedDB client reconciles a legacy ignore policy and restarts fast', async () => {
	const name = `node-policy-${crypto.randomUUID()}`
	let local = idbStorage(name)
	let localVolume = volume(local)
	await localVolume.mkdir('/private')
	await localVolume.writeFile('/private/local.txt', bytes('local'))
	await localVolume.writeFile('/private/different.txt', bytes('client'))
	await localVolume.mkdir('/.state', { recursive: true })
	await localVolume.writeFile('/.state/sync', bytes(JSON.stringify({ schemaVersion: 1 })))
	const requests: string[] = []
	const remoteServer = server(requests)
	const serverVolume = volume(remoteServer.storage)
	await serverVolume.mkdir('/private')
	await serverVolume.writeFile('/private/remote.txt', bytes('remote'))
	await serverVolume.writeFile('/private/different.txt', bytes('server'))

	const ignored = await synced({
		local,
		remote: ({ clientId }) =>
			remoteNodeSyncReplica(remoteServer.client, { clientId, ignore: ['/private'] }),
		ignore: ['/private'],
		interval: 99_999
	})
	expect(text(await ignored.readFile('/private/local.txt'))).toBe('local')
	expect(await ignored.exists('/private/remote.txt')).toBe(false)
	ignored.destroy()
	local.destroy()

	local = idbStorage(name)
	localVolume = volume(local)
	const visible = await synced({
		local,
		remote: ({ clientId }) => remoteNodeSyncReplica(remoteServer.client, { clientId }),
		interval: 99_999
	})
	expect(text(await visible.readFile('/private/remote.txt'))).toBe('remote')
	expect(text(await visible.readFile('/private/different.txt'))).toBe('server')
	expect(text(await serverVolume.readFile('/private/local.txt'))).toBe('local')
	visible.destroy()
	const scans = requests.filter((request) => request === 'GET /node/snapshot').length
	const second = await synced({
		local,
		remote: ({ clientId }) => remoteNodeSyncReplica(remoteServer.client, { clientId }),
		interval: 99_999
	})
	expect(requests.filter((request) => request === 'GET /node/snapshot')).toHaveLength(scans)
	second.destroy()
	local.destroy()
	remoteServer.database.close()
})

test('an offline IndexedDB create survives restart and syncs through HTTP with its node IDs', async () => {
	const name = `node-http-${crypto.randomUUID()}`
	const first = idbStorage(name)
	const firstVolume = volume(first)
	await firstVolume.mkdir('/docs')
	await firstVolume.writeFile('/docs/note.md', bytes('hello'))
	const firstIno = (await firstVolume.lstat('/docs/note.md')).ino
	const expectedIds = mutationsOf(
		(await nodeReplica(first).nodeDeltas('', { limit: 10 })).operations
	)
		.filter((mutation) => mutation.kind === 'create')
		.map((mutation) => mutation.nodeId)
	first.destroy()

	const sourceStorage = idbStorage(name)
	const source = nodeReplica(sourceStorage)
	const outgoing = await source.nodeDeltas('', { limit: 10 })
	const remoteServer = server()
	await remoteServer.remote.applyNodeOperations(outgoing.operations, (hash) =>
		source.getBlobByHash(hash)
	)
	expect((await volume(remoteServer.storage).lstat('/docs/note.md')).ino).not.toBe(firstIno)

	const targetStorage = idbStorage(`node-http-target-${crypto.randomUUID()}`)
	const target = nodeReplica(targetStorage)
	const seenIds: string[] = []
	let token: string | undefined
	let session: string | undefined
	do {
		const page = await remoteServer.remote.nodeSnapshot(token, { limit: 1 })
		if (page.status !== 'ok') throw new Error(page.status)
		session = page.session
		seenIds.push(
			...mutationsOf(page.operations)
				.filter((mutation) => mutation.kind === 'create')
				.map((mutation) => mutation.nodeId)
		)
		await target.applyNodeOperations(page.operations, async (hash) => {
			const blob = await remoteServer.remote.getSnapshotBlob(page.session, hash)
			if (blob.status !== 'ok') throw new Error(blob.status)
			return blob.data
		})
		token = page.next
	} while (token)
	if (!session) throw new Error('missing snapshot session')
	await remoteServer.remote.closeSnapshot(session)

	expect(seenIds).toEqual(expectedIds)
	expect(text(await volume(targetStorage).readFile('/docs/note.md'))).toBe('hello')
	expect((await volume(targetStorage).lstat('/docs/note.md')).ino).not.toBe(firstIno)
	targetStorage.destroy()
	sourceStorage.destroy()
	remoteServer.database.close()
})

test('an IndexedDB move with 4,000 descendants sends one HTTP mutation and no blob', async () => {
	const requests: string[] = []
	const remoteServer = server(requests)
	const sourceStorage = idbStorage(`node-http-move-${crypto.randomUUID()}`)
	const source = nodeReplica(sourceStorage)
	const sourceVolume = volume(sourceStorage)
	await sourceVolume.mkdir('/old/tree', { recursive: true })
	await sourceVolume.mkdir('/new')
	for (let index = 0; index < 4000; index++)
		await sourceVolume.writeFile(`/old/tree/f${index}.txt`, bytes('same'))

	let outgoing = await source.nodeDeltas('', { limit: 10_000 })
	await remoteServer.remote.applyNodeOperations(outgoing.operations, (hash) =>
		source.getBlobByHash(hash)
	)
	const sourceCursor = outgoing.to
	const serverCursor = (await remoteServer.remote.nodeDeltas('', { limit: 10_000 })).to
	requests.length = 0

	await sourceVolume.rename('/old/tree', '/new/tree')
	outgoing = await source.nodeDeltas(sourceCursor, { limit: 10 })
	const getBlob = vi.fn((hash: string) => source.getBlobByHash(hash))
	await remoteServer.remote.applyNodeOperations(outgoing.operations, getBlob)

	expect(outgoing.operations).toHaveLength(1)
	expect(outgoing.operations[0]?.mutations).toEqual([
		expect.objectContaining({ kind: 'move', name: 'tree' })
	])
	expect(
		(await remoteServer.remote.nodeDeltas(serverCursor, { limit: 10 })).operations
	).toHaveLength(1)
	expect(getBlob).not.toHaveBeenCalled()
	expect(requests.filter((request) => request.startsWith('PUT /node/blob/'))).toEqual([])
	expect(text(await volume(remoteServer.storage).readFile('/new/tree/f3999.txt'))).toBe('same')
	expect(await volume(remoteServer.storage).exists('/old/tree')).toBe(false)
	sourceStorage.destroy()
	remoteServer.database.close()
}, 30_000)
