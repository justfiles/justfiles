import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { volume } from '@justfiles/fs'
import { storageSyncReplica, synced } from '@justfiles/sync'
import {
	IgnoreCursorError,
	IgnoreProtocolError,
	type NodeMutation,
	NodeOperationRejectedError,
	type NodeReplica,
	ROOT_NODE_ID
} from '@justfiles/sync/node'
import { nodeMemStorage } from '@justfiles/sync/storage/node-mem'
import { afterEach, describe, expect, test } from 'vitest'
import { nodeSyncConformanceCases } from '../../sync/node-test-harness'
import type { DbAdapter } from './db'
import { createSqliteAdapter } from './db.sqlite'
import { createFsApi } from './fs'
import { createFsClient, remoteNodeSyncReplica } from './fs.client'
import { readGenerationState, resetVolume } from './reset'
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
	const adapter = failNodeJournal(
		createSqliteAdapter(db64 as unknown as Parameters<typeof createSqliteAdapter>[0]),
		failure
	)
	return {
		db,
		adapter,
		storage: sqliteStorage(adapter)
	}
}

function wireClient(
	app: ReturnType<typeof createFsApi>,
	requests?: string[],
	transform?: (request: Request, response: Response) => Promise<Response>
) {
	return createFsClient({
		baseUrl: 'http://node-sync.test',
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init)
			requests?.push(`${request.method} ${new URL(request.url).pathname}`)
			const response = await app.request(request)
			return transform ? transform(request, response) : response
		}) as typeof fetch
	})
}

async function nodeSubscriptionHeader(app: ReturnType<typeof createFsApi>) {
	const hash = createHash('sha256').update('[]').digest('hex')
	const response = await app.request('/node/subscription', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ignore: [], hash })
	})
	const body = (await response.json()) as { subscription: string }
	return { 'x-sync-subscription': body.subscription }
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

test('HTTP node subscriptions union ignore roots and fence their cursors', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.mkdir('/server-private')
	await serverVolume.writeFile('/server-private/token', bytes('server secret'))
	await serverVolume.mkdir('/client-private')
	await serverVolume.writeFile('/client-private/token', bytes('client secret'))
	await serverVolume.writeFile('/shared.txt', bytes('shared'))
	const app = createFsApi(server.storage, {
		ignore: ['/server-private'],
		lineage: () => ({ generation: 1, lineageId: 'volume-a' })
	})
	const remote = remoteNodeSyncReplica(wireClient(app), {
		clientId: 'client-a',
		ignore: ['/client-private/']
	})
	const policy = await remote.subscription()

	expect(policy).toMatchObject({
		effectiveIgnore: ['/client-private', '/server-private'],
		identityEpoch: 'volume-a'
	})
	expect(policy.effectiveHash).toMatch(/^[0-9a-f]{64}$/)

	let pageToken: string | undefined
	let cursor = ''
	const snapshotMutations: NodeMutation[] = []
	do {
		const page = await remote.nodeSnapshot(pageToken, { limit: 1 })
		if (page.status !== 'ok') throw new Error(page.status)
		snapshotMutations.push(...page.operations.flatMap((operation) => operation.mutations))
		cursor = page.syncCursor
		pageToken = page.next
		if (!pageToken) await remote.closeSnapshot(page.session)
	} while (pageToken)
	expect(snapshotMutations.map((mutation) => mutation.nodeId)).toHaveLength(1)
	expect(snapshotMutations[0]).toMatchObject({ kind: 'create', name: 'shared.txt' })

	const hiddenHash = (await serverVolume.stat('/server-private/token')).contentHash
	if (!hiddenHash) throw new Error('missing hidden hash')
	await expect(remote.getBlobByHash(hiddenHash)).rejects.toThrow('node getBlobByHash failed: 404')

	await serverVolume.writeFile('/later.txt', bytes('later'))
	await serverVolume.writeFile('/client-private/token', bytes('new client secret'))
	await serverVolume.rm('/server-private/token')
	const delta = await remote.nodeDeltas(cursor, { limit: 100 })
	const deltaMutations = delta.operations.flatMap((operation) => operation.mutations)
	expect(deltaMutations).toHaveLength(1)
	expect(deltaMutations[0]).toMatchObject({ kind: 'create', name: 'later.txt' })

	const otherPolicy = remoteNodeSyncReplica(wireClient(app), {
		clientId: 'client-b',
		ignore: ['/other']
	})
	await expect(otherPolicy.nodeDeltas(cursor, { limit: 100 })).rejects.toBeInstanceOf(
		IgnoreCursorError
	)
	const otherEpoch = remoteNodeSyncReplica(
		wireClient(
			createFsApi(server.storage, {
				ignore: ['/server-private'],
				lineage: () => ({ generation: 2, lineageId: 'volume-b' })
			})
		),
		{ clientId: 'client-a', ignore: ['/client-private'] }
	)
	await expect(otherEpoch.nodeDeltas(cursor, { limit: 100 })).rejects.toBeInstanceOf(
		IgnoreCursorError
	)
	server.db.close()
})

test.each([
	'wrong-hash',
	'missing-client-root'
] as const)('HTTP node subscriptions reject a %s response before snapshot work', async (failure) => {
	const server = openSqlite(':memory:')
	const requests: string[] = []
	const app = createFsApi(server.storage)
	const client = wireClient(app, requests, async (request, response) => {
		if (new URL(request.url).pathname !== '/node/subscription') return response
		const body = (await response.json()) as Record<string, unknown>
		if (failure === 'wrong-hash') body.effectiveHash = '0'.repeat(64)
		else {
			body.effectiveIgnore = []
			body.effectiveHash = createHash('sha256').update('[]').digest('hex')
		}
		return Response.json(body, { status: response.status })
	})
	const remote = remoteNodeSyncReplica(client, {
		clientId: 'client-a',
		ignore: ['/client-private']
	})

	await expect(remote.subscription()).rejects.toBeInstanceOf(IgnoreProtocolError)
	expect(requests).toEqual(['POST /node/subscription'])
	server.db.close()
})

test('a new client ignore root keeps offline client and server bytes independent', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	const local = nodeMemStorage()
	const client = wireClient(createFsApi(server.storage))
	const first = await synced({
		local,
		remote: ({ clientId }) => remoteNodeSyncReplica(client, { clientId }),
		interval: 99_999
	})
	await first.mkdir('/private')
	await first.writeFile('/private/token', bytes('baseline'))
	await first.flush()
	first.destroy()

	await volume(local).writeFile('/private/token', bytes('client offline'))
	await serverVolume.writeFile('/private/token', bytes('server offline'))
	const requests: string[] = []
	const secondClient = wireClient(createFsApi(server.storage), requests)
	const second = await synced({
		local,
		remote: ({ clientId }) =>
			remoteNodeSyncReplica(secondClient, { clientId, ignore: ['/private'] }),
		ignore: ['/private'],
		interval: 99_999
	})

	expect(text(await second.readFile('/private/token'))).toBe('client offline')
	expect(text(await serverVolume.readFile('/private/token'))).toBe('server offline')
	await second.writeFile('/private/token', bytes('client later'))
	await second.writeFile('/private/local-only.txt', bytes('never mapped'))
	await serverVolume.writeFile('/private/token', bytes('server later'))
	await second.flush()
	expect(text(await second.readFile('/private/token'))).toBe('client later')
	expect(text(await serverVolume.readFile('/private/token'))).toBe('server later')
	expect(requests.filter((request) => request.includes('/node/blob/'))).toEqual([])

	const localView = local.caps.sync.project(['/.state', '/private'])
	const localSnapshot = await localView.nodeSnapshot(undefined, { limit: 100 })
	if (localSnapshot.status !== 'ok') throw new Error(localSnapshot.status)
	expect(localSnapshot.operations).toEqual([])
	await localView.closeSnapshot(localSnapshot.session)
	const rawSnapshot = await local.caps.sync.nodeSnapshot(undefined, { limit: 100 })
	if (rawSnapshot.status !== 'ok') throw new Error(rawSnapshot.status)
	expect(
		rawSnapshot.operations
			.flatMap((operation) => operation.mutations)
			.some((mutation) => mutation.kind === 'create' && mutation.name === 'local-only.txt')
	).toBe(false)
	await local.caps.sync.closeSnapshot(rawSnapshot.session)
	second.destroy()
	server.db.close()
})

test('removing an ignore root applies remote authority and publishes local-only paths', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	const local = nodeMemStorage()
	const ignoredClient = wireClient(createFsApi(server.storage))
	const ignored = await synced({
		local,
		remote: ({ clientId }) =>
			remoteNodeSyncReplica(ignoredClient, { clientId, ignore: ['/private'] }),
		ignore: ['/private'],
		interval: 99_999
	})
	await ignored.mkdir('/private')
	await ignored.writeFile('/private/local.txt', bytes('local'))
	await ignored.writeFile('/private/different.txt', bytes('client'))
	await ignored.writeFile('/private/equal.txt', bytes('equal'))
	await ignored.mkdir('/private/kind')
	await ignored.writeFile('/private/kind/child.txt', bytes('client child'))
	await ignored.mkdir('/private/folder')
	await ignored.writeFile('/private/folder/local-child.txt', bytes('local child'))
	await ignored.writeFile('/private/folder/collision.txt', bytes('client collision'))
	await ignored.flush()
	ignored.destroy()

	await serverVolume.mkdir('/private')
	await serverVolume.writeFile('/private/remote.txt', bytes('remote'))
	await serverVolume.writeFile('/private/different.txt', bytes('server'))
	await serverVolume.writeFile('/private/equal.txt', bytes('equal'))
	await serverVolume.writeFile('/private/kind', bytes('server file'))
	await serverVolume.mkdir('/private/folder')
	await serverVolume.writeFile('/private/folder/remote-child.txt', bytes('remote child'))
	await serverVolume.writeFile('/private/folder/collision.txt', bytes('server collision'))

	const requests: string[] = []
	const visibleClient = wireClient(createFsApi(server.storage), requests)
	const visible = await synced({
		local,
		remote: ({ clientId }) => remoteNodeSyncReplica(visibleClient, { clientId }),
		interval: 99_999
	})
	await visible.flush()

	expect(text(await visible.readFile('/private/remote.txt'))).toBe('remote')
	expect(text(await visible.readFile('/private/different.txt'))).toBe('server')
	expect(text(await visible.readFile('/private/equal.txt'))).toBe('equal')
	expect(text(await visible.readFile('/private/kind'))).toBe('server file')
	expect(text(await visible.readFile('/private/folder/collision.txt'))).toBe('server collision')
	expect(text(await visible.readFile('/private/folder/remote-child.txt'))).toBe('remote child')
	expect(text(await visible.readFile('/private/folder/local-child.txt'))).toBe('local child')
	expect(text(await serverVolume.readFile('/private/local.txt'))).toBe('local')
	expect(text(await serverVolume.readFile('/private/folder/local-child.txt'))).toBe('local child')
	const equalHash = (await serverVolume.stat('/private/equal.txt')).contentHash
	if (!equalHash) throw new Error('missing equal hash')
	expect(requests.some((request) => request.endsWith(`/blob/${equalHash}`))).toBe(false)
	visible.destroy()
	server.db.close()
})

test('policy reconciliation does not republish a stale remote deletion', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.writeFile('/gone.txt', bytes('gone'))
	const local = nodeMemStorage()
	const app = createFsApi(server.storage)
	const first = await synced({
		local,
		remote: ({ clientId }) => remoteNodeSyncReplica(wireClient(app), { clientId }),
		interval: 99_999
	})
	first.destroy()
	await serverVolume.rm('/gone.txt')
	await volume(local).writeFile('/mine.txt', bytes('mine'))

	const second = await synced({
		local,
		remote: ({ clientId }) =>
			remoteNodeSyncReplica(wireClient(app), { clientId, ignore: ['/unused'] }),
		ignore: ['/unused'],
		interval: 99_999
	})
	await second.flush()

	expect(await second.exists('/gone.txt')).toBe(false)
	expect(await serverVolume.exists('/gone.txt')).toBe(false)
	expect(text(await serverVolume.readFile('/mine.txt'))).toBe('mine')
	second.destroy()
	server.db.close()
})

test('a legacy SQLite client establishes one ignore-policy baseline', async () => {
	const local = openSqlite(':memory:')
	const localVolume = volume(local.storage)
	await localVolume.mkdir('/private')
	await localVolume.writeFile('/private/token', bytes('client secret'))
	await localVolume.writeFile('/local.txt', bytes('local'))
	await localVolume.writeFile('/conflict.txt', bytes('client'))
	await localVolume.mkdir('/.state', { recursive: true })
	await localVolume.writeFile(
		'/.state/sync',
		bytes(JSON.stringify({ schemaVersion: 1, nodePushCursor: 'legacy', nodePullCursor: 'legacy' }))
	)

	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.mkdir('/private')
	await serverVolume.writeFile('/private/token', bytes('server secret'))
	await serverVolume.writeFile('/remote.txt', bytes('remote'))
	await serverVolume.writeFile('/conflict.txt', bytes('server'))
	const requests: string[] = []
	const client = wireClient(createFsApi(server.storage), requests)
	const connect = () =>
		synced({
			local: local.storage,
			remote: ({ clientId }) => remoteNodeSyncReplica(client, { clientId, ignore: ['/private'] }),
			ignore: ['/private'],
			interval: 99_999
		})

	const first = await connect()
	expect(text(await first.readFile('/private/token'))).toBe('client secret')
	expect(text(await serverVolume.readFile('/private/token'))).toBe('server secret')
	expect(text(await first.readFile('/conflict.txt'))).toBe('server')
	expect(text(await first.readFile('/remote.txt'))).toBe('remote')
	expect(text(await serverVolume.readFile('/local.txt'))).toBe('local')
	first.destroy()
	const scans = requests.filter((request) => request === 'GET /node/snapshot').length
	expect(scans).toBeGreaterThan(0)

	const state = JSON.parse(text(await localVolume.readFile('/.state/sync'))) as Record<
		string,
		unknown
	>
	expect(state).toMatchObject({
		effectiveIgnore: ['/private'],
		effectiveHash: expect.stringMatching(/^[0-9a-f]{64}$/),
		remoteIdentityEpoch: 'node-v2'
	})
	const second = await connect()
	expect(requests.filter((request) => request === 'GET /node/snapshot')).toHaveLength(scans)
	second.destroy()
	local.db.close()
	server.db.close()
})

test.each([
	'snapshot',
	'local',
	'remote',
	'before-commit',
	'after-commit'
] as const)('ignore reconciliation resumes after a %s crash', async (crashPoint) => {
	const local = openSqlite(':memory:')
	const server = openSqlite(':memory:')
	const app = createFsApi(server.storage)
	const connect = (
		storage: typeof local.storage,
		wrapRemote: (remote: NodeReplica) => NodeReplica = (remote) => remote
	) =>
		synced({
			local: storage,
			remote: ({ clientId }) => wrapRemote(remoteNodeSyncReplica(wireClient(app), { clientId })),
			interval: 99_999
		})

	const ignored = await synced({
		local: local.storage,
		remote: ({ clientId }) =>
			remoteNodeSyncReplica(wireClient(app), { clientId, ignore: ['/private'] }),
		ignore: ['/private'],
		interval: 99_999
	})
	await ignored.mkdir('/private')
	await ignored.writeFile('/private/local.txt', bytes('local'))
	await volume(server.storage).mkdir('/private')
	await volume(server.storage).writeFile('/private/remote.txt', bytes('remote'))
	ignored.destroy()
	const serverReplica = nodeReplica(server.storage)
	const before = (await serverReplica.nodeDeltas('', { limit: 100 })).to
	const stateIno = (await volume(local.storage).lstat('/.state/sync')).ino
	const visibleHash = createHash('sha256').update('[]').digest('hex')
	let crashed = false
	const crashState = (state: Record<string, unknown>): boolean => {
		const reconcile = state.reconcile as { phase?: string } | undefined
		if (crashPoint === 'local') return reconcile?.phase === 'local'
		if (crashPoint === 'remote') return reconcile?.phase === 'remote'
		if (crashPoint === 'before-commit') return reconcile?.phase === 'commit'
		return (
			crashPoint === 'after-commit' &&
			state.effectiveHash === visibleHash &&
			reconcile === undefined
		)
	}
	const crashingStorage = new Proxy(local.storage, {
		get(target, property, receiver) {
			if (property !== 'putBlob' || crashPoint === 'snapshot')
				return Reflect.get(target, property, receiver)
			return async (ino: string, data: Uint8Array) => {
				await target.putBlob(ino, data)
				if (ino !== stateIno || crashed) return
				const state = JSON.parse(text(data)) as Record<string, unknown>
				if (!crashState(state)) return
				crashed = true
				throw new Error(`crash:${crashPoint}`)
			}
		}
	}) as typeof local.storage
	const wrapRemote = (remote: NodeReplica): NodeReplica => {
		if (crashPoint !== 'snapshot') return remote
		let pages = 0
		return {
			...remote,
			async nodeSnapshot(page) {
				if (pages++ === 1) throw new Error('crash:snapshot')
				return remote.nodeSnapshot(page, { limit: 1 })
			}
		}
	}

	const interrupted = await connect(crashingStorage, wrapRemote)
	expect(interrupted.status()).toBe('error')
	interrupted.destroy()
	const recovered = await connect(local.storage)
	expect(recovered.status()).toBe('synced')
	expect(text(await recovered.readFile('/private/remote.txt'))).toBe('remote')
	expect(text(await volume(server.storage).readFile('/private/local.txt'))).toBe('local')
	const published = await serverReplica.nodeDeltas(before, { limit: 100 })
	expect(published.operations.flatMap((operation) => operation.mutations)).toEqual([
		expect.objectContaining({ kind: 'create', name: 'local.txt' })
	])
	recovered.destroy()
	local.db.close()
	server.db.close()
})

test('local-first writes stay ordered behind ignore reconciliation', async () => {
	const local = openSqlite(':memory:')
	const server = openSqlite(':memory:')
	const app = createFsApi(server.storage)
	let snapshotStarted!: () => void
	let releaseSnapshot!: () => void
	const started = new Promise<void>((resolve) => {
		snapshotStarted = resolve
	})
	const blocked = new Promise<void>((resolve) => {
		releaseSnapshot = resolve
	})
	const client = await synced({
		local: local.storage,
		remote: ({ clientId }) => {
			const remote = remoteNodeSyncReplica(wireClient(app), {
				clientId,
				ignore: ['/private']
			})
			return {
				...remote,
				async nodeSnapshot(page, options) {
					snapshotStarted()
					await blocked
					return remote.nodeSnapshot(page, options)
				}
			}
		},
		ignore: ['/private'],
		localFirst: true,
		interval: 99_999
	})
	await started
	await client.writeFile('/during.txt', bytes('visible'))
	await client.mkdir('/private')
	await client.writeFile('/private/during.txt', bytes('ignored'))
	releaseSnapshot()
	await client.flush()
	expect(client.status()).toBe('synced')
	await client.writeFile('/during.txt', bytes('visible later'))
	await client.flush()

	expect(text(await client.readFile('/during.txt'))).toBe('visible later')
	expect(text(await client.readFile('/private/during.txt'))).toBe('ignored')
	expect(text(await volume(server.storage).readFile('/during.txt'))).toBe('visible later')
	expect(await volume(server.storage).exists('/private')).toBe(false)
	client.destroy()
	local.db.close()
	server.db.close()
})

test('filesystem moves publish and unpublish at an ignore boundary', async () => {
	const server = openSqlite(':memory:')
	const requests: string[] = []
	const app = createFsApi(server.storage)
	const local = openSqlite(':memory:')
	const client = await synced({
		local: local.storage,
		remote: ({ clientId }) =>
			remoteNodeSyncReplica(wireClient(app, requests), { clientId, ignore: ['/hidden'] }),
		ignore: ['/hidden'],
		interval: 99_999
	})
	await client.mkdir('/visible/tree', { recursive: true })
	await client.writeFile('/visible/tree/file.txt', bytes('content'))
	await client.mkdir('/hidden')
	await client.flush()
	const before = await nodeReplica(server.storage).nodeSnapshot(undefined, { limit: 100 })
	if (before.status !== 'ok') throw new Error(before.status)
	const oldTree = before.operations
		.flatMap((operation) => operation.mutations)
		.find((mutation) => mutation.kind === 'create' && mutation.name === 'tree')
	if (!oldTree) throw new Error('missing old tree')
	await nodeReplica(server.storage).closeSnapshot(before.session)

	await client.rename('/visible/tree', '/hidden/tree')
	await client.flush()
	expect(text(await client.readFile('/hidden/tree/file.txt'))).toBe('content')
	expect(await volume(server.storage).exists('/visible/tree')).toBe(false)
	expect(await volume(server.storage).exists('/hidden')).toBe(false)

	requests.length = 0
	await client.rename('/hidden/tree', '/hidden/renamed')
	await client.flush()
	expect(requests.filter((request) => request === 'POST /node/operations')).toEqual([])

	await client.rename('/hidden/renamed', '/visible/tree')
	await client.flush()
	expect(text(await volume(server.storage).readFile('/visible/tree/file.txt'))).toBe('content')
	const after = await nodeReplica(server.storage).nodeSnapshot(undefined, { limit: 100 })
	if (after.status !== 'ok') throw new Error(after.status)
	const newTree = after.operations
		.flatMap((operation) => operation.mutations)
		.find((mutation) => mutation.kind === 'create' && mutation.name === 'tree')
	if (!newTree) throw new Error('missing new tree')
	expect(newTree.nodeId).not.toBe(oldTree.nodeId)
	await nodeReplica(server.storage).closeSnapshot(after.session)
	client.destroy()
	local.db.close()
	server.db.close()
})

test('a move across nested ignore roots is one projected operation', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	const local = openSqlite(':memory:')
	const app = createFsApi(server.storage)
	const ignore = ['/dst/tree/hide', '/src/tree/secret']
	const client = await synced({
		local: local.storage,
		remote: ({ clientId }) => remoteNodeSyncReplica(wireClient(app), { clientId, ignore }),
		ignore,
		interval: 99_999
	})
	await client.mkdir('/src/tree/hide', { recursive: true })
	await client.mkdir('/src/tree/secret', { recursive: true })
	await client.mkdir('/dst')
	await client.writeFile('/src/tree/keep.txt', bytes('keep'))
	await client.writeFile('/src/tree/hide/old.txt', bytes('old visible'))
	await client.writeFile('/src/tree/secret/new.txt', bytes('new visible'))
	await client.flush()
	const replica = nodeReplica(server.storage)
	const before = (await replica.nodeDeltas('', { limit: 100 })).to

	await client.rename('/src/tree', '/dst/tree')
	await client.flush()

	const projected = await replica.nodeDeltas(before, { limit: 100 })
	expect(projected.operations).toHaveLength(1)
	expect(projected.operations[0]?.mutations.map((mutation) => mutation.kind)).toEqual([
		'delete',
		'delete',
		'move',
		'create',
		'create'
	])
	expect(text(await serverVolume.readFile('/dst/tree/keep.txt'))).toBe('keep')
	expect(text(await serverVolume.readFile('/dst/tree/secret/new.txt'))).toBe('new visible')
	expect(await serverVolume.exists('/dst/tree/hide')).toBe(false)
	expect(await serverVolume.exists('/src/tree')).toBe(false)
	expect(text(await client.readFile('/dst/tree/hide/old.txt'))).toBe('old visible')
	client.destroy()
	local.db.close()
	server.db.close()
})

test('remote moves detach and reattach across a client ignore boundary', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.mkdir('/visible/tree', { recursive: true })
	await serverVolume.writeFile('/visible/tree/file.txt', bytes('content'))
	await serverVolume.mkdir('/hidden')
	const local = openSqlite(':memory:')
	const app = createFsApi(server.storage)
	const client = await synced({
		local: local.storage,
		remote: ({ clientId }) =>
			remoteNodeSyncReplica(wireClient(app), { clientId, ignore: ['/hidden'] }),
		ignore: ['/hidden'],
		interval: 99_999
	})

	await serverVolume.rename('/visible/tree', '/hidden/tree')
	await client.flush()
	expect(await client.exists('/visible/tree')).toBe(false)
	expect(await client.exists('/hidden')).toBe(false)
	expect(text(await serverVolume.readFile('/hidden/tree/file.txt'))).toBe('content')

	await serverVolume.rename('/hidden/tree', '/visible/tree')
	await client.flush()
	expect(text(await client.readFile('/visible/tree/file.txt'))).toBe('content')
	client.destroy()
	local.db.close()
	server.db.close()
})

test('remote ancestor deletion preserves an ignored local descendant', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.mkdir('/shared/private', { recursive: true })
	await serverVolume.writeFile('/shared/public.txt', bytes('public'))
	const local = openSqlite(':memory:')
	const app = createFsApi(server.storage)
	const client = await synced({
		local: local.storage,
		remote: ({ clientId }) =>
			remoteNodeSyncReplica(wireClient(app), {
				clientId,
				ignore: ['/shared/private']
			}),
		ignore: ['/shared/private'],
		interval: 99_999
	})
	await client.mkdir('/shared/private', { recursive: true })
	await client.writeFile('/shared/private/local.txt', bytes('local'))

	await serverVolume.rm('/shared', { recursive: true })
	await client.flush()

	expect(await client.exists('/shared/public.txt')).toBe(false)
	expect(text(await client.readFile('/shared/private/local.txt'))).toBe('local')
	expect(await serverVolume.exists('/shared/private/local.txt')).toBe(false)

	await serverVolume.writeFile('/shared', bytes('remote file'))
	await client.flush()
	expect(text(await client.readFile('/shared/private/local.txt'))).toBe('local')
	expect(text(await serverVolume.readFile('/shared'))).toBe('remote file')
	await serverVolume.writeFile('/shared', bytes('remote file later'))
	await client.flush()
	await serverVolume.rm('/shared')
	await serverVolume.mkdir('/shared')
	await serverVolume.writeFile('/shared/new-public.txt', bytes('new public'))
	await client.flush()
	expect(text(await client.readFile('/shared/private/local.txt'))).toBe('local')
	expect(text(await client.readFile('/shared/new-public.txt'))).toBe('new public')
	client.destroy()
	local.db.close()
	server.db.close()
})

test('remote ancestor move leaves an ignored local descendant in place', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.mkdir('/shared/nested', { recursive: true })
	await serverVolume.writeFile('/shared/public.txt', bytes('public'))
	const local = openSqlite(':memory:')
	const app = createFsApi(server.storage)
	const client = await synced({
		local: local.storage,
		remote: ({ clientId }) =>
			remoteNodeSyncReplica(wireClient(app), {
				clientId,
				ignore: ['/shared/nested/private']
			}),
		ignore: ['/shared/nested/private'],
		interval: 99_999
	})
	await client.mkdir('/shared/nested/private', { recursive: true })
	await client.writeFile('/shared/nested/private/local.txt', bytes('local'))

	await serverVolume.rename('/shared', '/moved')
	await client.flush()

	expect(text(await client.readFile('/moved/public.txt'))).toBe('public')
	expect(text(await client.readFile('/shared/nested/private/local.txt'))).toBe('local')
	expect(await client.exists('/moved/nested/private')).toBe(false)
	expect(await serverVolume.exists('/moved/nested/private/local.txt')).toBe(false)
	client.destroy()
	local.db.close()
	server.db.close()
})

test('two clients keep independent ignore subscriptions', async () => {
	const server = openSqlite(':memory:')
	const app = createFsApi(server.storage)
	const oldLocal = openSqlite(':memory:')
	const newLocal = openSqlite(':memory:')
	await volume(newLocal.storage).mkdir('/private')
	await volume(newLocal.storage).writeFile('/private/local.txt', bytes('new client only'))
	const oldClient = await synced({
		local: oldLocal.storage,
		remote: ({ clientId }) => remoteNodeSyncReplica(wireClient(app), { clientId }),
		interval: 99_999
	})
	const newClient = await synced({
		local: newLocal.storage,
		remote: ({ clientId }) =>
			remoteNodeSyncReplica(wireClient(app), { clientId, ignore: ['/private'] }),
		ignore: ['/private'],
		interval: 99_999
	})

	await oldClient.mkdir('/private')
	await oldClient.writeFile('/private/server.txt', bytes('old release'))
	await oldClient.writeFile('/outside.txt', bytes('from old'))
	await oldClient.flush()
	await newClient.flush()
	expect(text(await newClient.readFile('/private/local.txt'))).toBe('new client only')
	expect(await newClient.exists('/private/server.txt')).toBe(false)
	expect(text(await newClient.readFile('/outside.txt'))).toBe('from old')

	await newClient.writeFile('/private/local.txt', bytes('new client later'))
	await newClient.writeFile('/outside.txt', bytes('from new'))
	await newClient.flush()
	await oldClient.flush()
	expect(text(await oldClient.readFile('/private/server.txt'))).toBe('old release')
	expect(await oldClient.exists('/private/local.txt')).toBe(false)
	expect(text(await oldClient.readFile('/outside.txt'))).toBe('from new')
	expect(text(await volume(server.storage).readFile('/outside.txt'))).toBe('from new')
	expect(await volume(server.storage).exists('/private/local.txt')).toBe(false)

	oldClient.destroy()
	newClient.destroy()
	oldLocal.db.close()
	newLocal.db.close()
	server.db.close()
})

test('a server ignore change fences old cursors and reconciles a dormant client', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.mkdir('/private')
	await serverVolume.writeFile('/private/token', bytes('baseline'))
	await serverVolume.writeFile('/outside.txt', bytes('baseline'))
	const firstApp = createFsApi(server.storage)
	const firstRemote = remoteNodeSyncReplica(wireClient(firstApp), { clientId: 'cursor-reader' })
	const oldCursor = (await firstRemote.nodeDeltas('', { limit: 100 })).to
	const local = openSqlite(':memory:')
	const first = await synced({
		local: local.storage,
		remote: ({ clientId }) => remoteNodeSyncReplica(wireClient(firstApp), { clientId }),
		interval: 99_999
	})
	first.destroy()
	await volume(local.storage).writeFile('/private/token', bytes('client offline'))
	await serverVolume.writeFile('/private/token', bytes('server offline'))

	const secondApp = createFsApi(server.storage, { ignore: ['/private'] })
	const restricted = remoteNodeSyncReplica(wireClient(secondApp), { clientId: 'restricted' })
	expect((await restricted.subscription()).effectiveIgnore).toEqual(['/private'])
	await expect(restricted.nodeDeltas(oldCursor, { limit: 100 })).rejects.toBeInstanceOf(
		IgnoreCursorError
	)
	const hiddenSnapshot = await restricted.nodeSnapshot(undefined, { limit: 100 })
	if (hiddenSnapshot.status !== 'ok') throw new Error(hiddenSnapshot.status)
	expect(hiddenSnapshot.operations).toEqual([
		expect.objectContaining({
			mutations: [expect.objectContaining({ kind: 'create', name: 'outside.txt' })]
		})
	])
	await restricted.closeSnapshot(hiddenSnapshot.session)

	const second = await synced({
		local: local.storage,
		remote: ({ clientId }) => remoteNodeSyncReplica(wireClient(secondApp), { clientId }),
		interval: 99_999
	})
	expect(text(await second.readFile('/private/token'))).toBe('client offline')
	expect(text(await serverVolume.readFile('/private/token'))).toBe('server offline')
	await second.writeFile('/private/token', bytes('client later'))
	await serverVolume.writeFile('/private/token', bytes('server later'))
	await serverVolume.writeFile('/outside.txt', bytes('outside later'))
	await second.flush()
	expect(text(await second.readFile('/private/token'))).toBe('client later')
	expect(text(await serverVolume.readFile('/private/token'))).toBe('server later')
	expect(text(await second.readFile('/outside.txt'))).toBe('outside later')
	second.destroy()

	const thirdApp = createFsApi(server.storage)
	const third = await synced({
		local: local.storage,
		remote: ({ clientId }) => remoteNodeSyncReplica(wireClient(thirdApp), { clientId }),
		interval: 99_999
	})
	expect(text(await third.readFile('/private/token'))).toBe('server later')
	expect(text(await serverVolume.readFile('/private/token'))).toBe('server later')
	third.destroy()
	local.db.close()
	server.db.close()
})

test('plain Storage reconciles a non-empty tree through node HTTP', async () => {
	const accelerated = nodeMemStorage()
	const { caps: _caps, ...local } = accelerated
	const localVolume = volume(local)
	await localVolume.writeFile('/local.txt', bytes('local'))
	await localVolume.writeFile('/equal.txt', bytes('equal'))
	await localVolume.writeFile('/different.txt', bytes('client'))
	await localVolume.writeFile('/move-old.txt', bytes('move'))
	await localVolume.writeFile('/delete.txt', bytes('delete'))
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.writeFile('/remote.txt', bytes('remote'))
	await serverVolume.writeFile('/equal.txt', bytes('equal'))
	await serverVolume.writeFile('/different.txt', bytes('server'))
	await serverVolume.writeFile('/move-old.txt', bytes('move'))
	await serverVolume.writeFile('/delete.txt', bytes('delete'))
	const app = createFsApi(server.storage)
	const client = await synced({
		local,
		remote: ({ clientId }) => remoteNodeSyncReplica(wireClient(app), { clientId }),
		interval: 99_999
	})

	expect(text(await client.readFile('/different.txt'))).toBe('server')
	expect(text(await client.readFile('/remote.txt'))).toBe('remote')
	expect(text(await serverVolume.readFile('/local.txt'))).toBe('local')
	await client.writeFile('/local.txt', bytes('local later'))
	await client.rename('/move-old.txt', '/move-new.txt')
	await client.rm('/delete.txt')
	await serverVolume.writeFile('/remote.txt', bytes('remote later'))
	await client.flush()

	expect(text(await serverVolume.readFile('/local.txt'))).toBe('local later')
	expect(text(await serverVolume.readFile('/move-new.txt'))).toBe('move')
	expect(await serverVolume.exists('/move-old.txt')).toBe(false)
	expect(await serverVolume.exists('/delete.txt')).toBe(false)
	expect(text(await client.readFile('/remote.txt'))).toBe('remote later')
	expect(client.status()).toBe('synced')
	client.destroy()
	server.db.close()
})

test('plain Storage preserves an ignored child through remote ancestor changes', async () => {
	const accelerated = nodeMemStorage()
	const { caps: _caps, ...local } = accelerated
	const localVolume = volume(local)
	await localVolume.mkdir('/shared/private', { recursive: true })
	await localVolume.writeFile('/shared/private/local.txt', bytes('local'))
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.mkdir('/shared')
	await serverVolume.writeFile('/shared/public.txt', bytes('public'))
	const app = createFsApi(server.storage)
	const client = await synced({
		local,
		remote: ({ clientId }) =>
			remoteNodeSyncReplica(wireClient(app), {
				clientId,
				ignore: ['/shared/private']
			}),
		ignore: ['/shared/private'],
		interval: 99_999
	})

	await serverVolume.rm('/shared', { recursive: true })
	await client.flush()
	expect(text(await client.readFile('/shared/private/local.txt'))).toBe('local')

	await serverVolume.writeFile('/shared', bytes('remote file'))
	await client.flush()
	expect(text(await client.readFile('/shared/private/local.txt'))).toBe('local')
	expect(text(await serverVolume.readFile('/shared'))).toBe('remote file')
	client.destroy()
	server.db.close()
})

test('plain Storage restarts a failed remote snapshot page', async () => {
	const accelerated = nodeMemStorage()
	const { caps: _caps, ...local } = accelerated
	const server = openSqlite(':memory:')
	await volume(server.storage).writeFile('/a.txt', bytes('a'))
	await volume(server.storage).writeFile('/b.txt', bytes('b'))
	const app = createFsApi(server.storage)
	const interrupted = await synced({
		local,
		remote: ({ clientId }) => {
			const remote = remoteNodeSyncReplica(wireClient(app), { clientId })
			let pages = 0
			return {
				...remote,
				async nodeSnapshot(page) {
					if (pages++ === 1) throw new Error('page crash')
					return remote.nodeSnapshot(page, { limit: 1 })
				}
			}
		},
		interval: 99_999
	})
	expect(interrupted.status()).toBe('error')
	interrupted.destroy()

	const recovered = await synced({
		local,
		remote: ({ clientId }) => remoteNodeSyncReplica(wireClient(app), { clientId }),
		interval: 99_999
	})
	expect(text(await recovered.readFile('/a.txt'))).toBe('a')
	expect(text(await recovered.readFile('/b.txt'))).toBe('b')
	expect(recovered.status()).toBe('synced')
	recovered.destroy()
	server.db.close()
})

test('HTTP node authority returns an exact create retry and rejects changed reuse', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'justfiles-node-operation-'))
	temporaryDirectories.push(directory)
	const filename = join(directory, 'fs.db')
	let server = openSqlite(filename)
	let app = createFsApi(server.storage, { actor: () => 'authenticated-user' })
	let subscription = await nodeSubscriptionHeader(app)
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
			headers: {
				'Content-Type': 'application/json',
				'x-fs-source': 'client-a',
				...subscription
			},
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
	subscription = await nodeSubscriptionHeader(app)
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

test('HTTP node authority returns a receipt after retry content is collected', async () => {
	const server = openSqlite(':memory:')
	const remote = remoteNodeSyncReplica(wireClient(createFsApi(server.storage)), {
		clientId: 'client-a'
	})
	const sourceStorage = nodeMemStorage()
	const source = memoryNodeReplica(sourceStorage)
	const sourceVolume = volume(sourceStorage)
	await sourceVolume.writeFile('/note.txt', bytes('old'))
	const create = await source.nodeDeltas('', { limit: 10 })
	const accepted = await remote.applyNodeOperations(create.operations, (hash) =>
		source.getBlobByHash(hash)
	)

	await sourceVolume.writeFile('/note.txt', bytes('new'))
	const update = await source.nodeDeltas(create.to, { limit: 10 })
	await remote.applyNodeOperations(update.operations, (hash) => source.getBlobByHash(hash))
	expect((await server.storage.caps?.content?.gcUnreferenced())?.reclaimed).toBe(1)

	await expect(
		remote.applyNodeOperations(create.operations, () =>
			Promise.reject(new Error('retry requested collected content'))
		)
	).resolves.toEqual(accepted)
	server.db.close()
})

test('destructive reset clears accepted node operations before republish', async () => {
	const server = openSqlite(':memory:')
	const sourceStorage = nodeMemStorage()
	const source = memoryNodeReplica(sourceStorage)
	await volume(sourceStorage).mkdir('/docs')
	const outgoing = await source.nodeDeltas('', { limit: 10 })
	const send = () =>
		remoteNodeSyncReplica(wireClient(createFsApi(server.storage)), {
			clientId: 'client-a'
		}).applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash))

	await send()
	const { lineageId } = await readGenerationState(server.adapter)
	await resetVolume(server.adapter, {
		mode: 'adopt-mine',
		fromGeneration: 1,
		operationId: 'reset',
		resetId: 'reset',
		lineageId
	})
	expect(await volume(server.storage).exists('/docs')).toBe(false)

	await send()
	expect(await volume(server.storage).exists('/docs')).toBe(true)
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

	const [accepted] = await remote.applyNodeOperations([move('move-a', a.nodeId)], () =>
		Promise.reject(new Error('move requested content'))
	)
	expect(accepted).toMatchObject({
		status: 'accepted',
		operation: {
			mutations: [
				{
					kind: 'move',
					fromParentId: ROOT_NODE_ID,
					fromName: 'note.txt'
				}
			]
		}
	})
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

test('HTTP node authority rejects a stale unpublish without partial deletion', async () => {
	const server = openSqlite(':memory:')
	const serverVolume = volume(server.storage)
	await serverVolume.mkdir('/tree')
	await serverVolume.writeFile('/tree/a.txt', bytes('a'))
	const remote = remoteNodeSyncReplica(wireClient(createFsApi(server.storage)), {
		clientId: 'client-a'
	})
	const snapshot = await remote.nodeSnapshot(undefined, { limit: 10 })
	if (snapshot.status !== 'ok') throw new Error(snapshot.status)
	const creates = snapshot.operations.flatMap((operation) => operation.mutations)
	const tree = creates.find((mutation) => mutation.kind === 'create' && mutation.name === 'tree')
	const child = creates.find((mutation) => mutation.kind === 'create' && mutation.name === 'a.txt')
	if (!tree || !child) throw new Error('missing snapshot nodes')
	await remote.closeSnapshot(snapshot.session)
	await serverVolume.writeFile('/tree/b.txt', bytes('b'))

	await expect(
		remote.applyNodeOperations(
			[
				{
					operationId: 'stale-unpublish',
					boundary: true,
					mutations: [
						{
							kind: 'delete',
							nodeId: child.nodeId,
							baseRevision: child.revision,
							revision: child.revision + 1
						},
						{
							kind: 'delete',
							nodeId: tree.nodeId,
							baseRevision: tree.revision,
							revision: tree.revision + 1
						}
					]
				}
			],
			() => Promise.reject(new Error('delete requested content'))
		)
	).rejects.toMatchObject({
		name: NodeOperationRejectedError.name,
		result: { status: 'rejected', reason: 'not_empty' }
	})
	expect(text(await serverVolume.readFile('/tree/a.txt'))).toBe('a')
	expect(text(await serverVolume.readFile('/tree/b.txt'))).toBe('b')
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

test('HTTP node authority publishes a replacement rename as one operation', async () => {
	const server = openSqlite(':memory:')
	const remote = remoteNodeSyncReplica(wireClient(createFsApi(server.storage)), {
		clientId: 'client-a'
	})
	const sourceStorage = nodeMemStorage()
	const source = memoryNodeReplica(sourceStorage)
	const sourceVolume = volume(sourceStorage)
	await sourceVolume.writeFile('/source.txt', bytes('source'))
	await sourceVolume.writeFile('/target.txt', bytes('target'))
	let outgoing = await source.nodeDeltas('', { limit: 10 })
	await remote.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash))
	const sourceCursor = outgoing.to
	const serverCursor = (await remote.nodeDeltas('', { limit: 10 })).to

	await sourceVolume.rename('/source.txt', '/target.txt')
	outgoing = await source.nodeDeltas(sourceCursor, { limit: 10 })
	expect(outgoing.operations).toHaveLength(1)
	expect(outgoing.operations[0]?.mutations.map((mutation) => mutation.kind)).toEqual([
		'delete',
		'move'
	])
	const stale = structuredClone(outgoing.operations)
	const staleMove = stale[0]?.mutations[1]
	if (staleMove?.kind !== 'move') throw new Error('missing replacement move')
	staleMove.baseRevision--
	await expect(
		remote.applyNodeOperations(stale, (hash) => source.getBlobByHash(hash))
	).rejects.toMatchObject({ result: { reason: 'stale' } })
	expect(text(await volume(server.storage).readFile('/source.txt'))).toBe('source')
	expect(text(await volume(server.storage).readFile('/target.txt'))).toBe('target')

	await remote.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash))
	expect(text(await volume(server.storage).readFile('/target.txt'))).toBe('source')
	expect(await volume(server.storage).exists('/source.txt')).toBe(false)
	const accepted = await remote.nodeDeltas(serverCursor, { limit: 10 })
	expect(accepted.operations).toHaveLength(1)
	expect(accepted.operations[0]?.mutations.map((mutation) => mutation.kind)).toEqual([
		'delete',
		'move'
	])
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
	const subscription = await nodeSubscriptionHeader(app)
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
			headers: { 'Content-Type': 'application/json', ...subscription, ...headers },
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
	const subscription = await nodeSubscriptionHeader(app)
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
		headers: {
			'Content-Type': 'application/json',
			'x-fs-source': 'client-a',
			...subscription
		},
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

test('HTTP authority content preflight ignores the proposed revision', async () => {
	const server = openSqlite(':memory:')
	await volume(server.storage).writeFile('/note.txt', bytes('old'))
	const remote = remoteNodeSyncReplica(wireClient(createFsApi(server.storage)), {
		clientId: 'client-a'
	})
	const sourceStorage = nodeMemStorage()
	const source = memoryNodeReplica(sourceStorage)
	const snapshot = await remote.nodeSnapshot(undefined, { limit: 10 })
	if (snapshot.status !== 'ok') throw new Error(snapshot.status)
	await source.applyNodeOperations(
		snapshot.operations,
		async (hash) => {
			const blob = await remote.getSnapshotBlob(snapshot.session, hash)
			if (blob.status !== 'ok') throw new Error(blob.status)
			return blob.data
		},
		{ source: 'server' }
	)
	await remote.closeSnapshot(snapshot.session)
	const cursor = (await source.nodeDeltas('', { limit: 10 })).to

	await volume(sourceStorage).writeFile('/note.txt', bytes('new'))
	const outgoing = await source.nodeDeltas(cursor, { limit: 10 })
	const update = outgoing.operations[0]?.mutations[0]
	if (update?.kind !== 'update') throw new Error('missing update')
	update.revision = update.baseRevision

	await remote.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash))
	expect(text(await volume(server.storage).readFile('/note.txt'))).toBe('new')
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
