import 'fake-indexeddb/auto'
import { volume } from '@justfiles/fs'
import type { Storage } from '@justfiles/fs/storage'
import { FileType } from '@justfiles/fs/types'
import { describe, expect, test, vi } from 'vitest'
import { hashBytes } from './content'
import { mutationsOf, type NodeReplica, ROOT_NODE_ID } from './node'
import { idbStorage } from './storage/idb'
import { nodeMemStorage } from './storage/node-mem'
import { storageSyncReplica } from './strategy'
import { twoPeers } from './sync-test-harness'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const text = (value: Uint8Array): string => new TextDecoder().decode(value)

async function abortNextNodeJournalWrite(task: () => Promise<unknown>): Promise<void> {
	const original = IDBObjectStore.prototype.put
	const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
		this: IDBObjectStore,
		value: unknown,
		key?: IDBValidKey
	) {
		if (this.name === 'nodeJournal') this.transaction.abort()
		return key === undefined ? original.call(this, value) : original.call(this, value, key)
	} as typeof original)
	try {
		await expect(task()).rejects.toBeDefined()
	} finally {
		failure.mockRestore()
	}
}

function nodeReplica(storage: Storage): NodeReplica {
	const selected = storageSyncReplica(storage)
	if (selected.strategy !== 'incremental') throw new Error('expected incremental sync')
	return selected.replica
}

function hideContent(storage: ReturnType<typeof idbStorage>): Storage {
	const caps = { ...storage.caps }
	delete caps.content
	return { ...storage, caps }
}

describe('IndexedDB node sync', () => {
	test('keeps created node IDs and local inode bindings across restart', async () => {
		const name = `node-restart-${crypto.randomUUID()}`
		const first = idbStorage(name)
		const firstVolume = volume(first)
		await firstVolume.mkdir('/docs')
		await firstVolume.writeFile('/docs/note.txt', new TextEncoder().encode('hello'))
		const firstReplica = nodeReplica(first)
		const before = mutationsOf((await firstReplica.nodeDeltas('', { limit: 10 })).operations)
		const ids = before
			.filter((mutation) => mutation.kind === 'create')
			.map((mutation) => mutation.nodeId)
		const inos = [
			(await firstVolume.lstat('/docs')).ino,
			(await firstVolume.lstat('/docs/note.txt')).ino
		]
		first.destroy()

		const second = idbStorage(name)
		const secondVolume = volume(second)
		const secondReplica = nodeReplica(second)
		const after = mutationsOf((await secondReplica.nodeDeltas('', { limit: 10 })).operations)

		expect(
			after.filter((mutation) => mutation.kind === 'create').map((mutation) => mutation.nodeId)
		).toEqual(ids)
		expect([
			(await secondVolume.lstat('/docs')).ino,
			(await secondVolume.lstat('/docs/note.txt')).ino
		]).toEqual(inos)
		second.destroy()
	})

	test('records user xattrs but keeps trusted sync xattrs local', async () => {
		const storage = idbStorage(`node-xattr-${crypto.randomUUID()}`)
		const storageVolume = volume(storage)
		const replica = nodeReplica(storage)
		await storageVolume.writeFile('/note.txt', bytes('note'))
		let cursor = (await replica.nodeDeltas('', { limit: 10 })).to

		await storageVolume.setXattr('/note.txt', 'user.label', bytes('tag'))
		let delta = await replica.nodeDeltas(cursor, { limit: 10 })
		let update = mutationsOf(delta.operations)[0]
		if (update?.kind !== 'update') throw new Error('missing xattr update')
		expect(update.meta.xattrs).toEqual({ 'user.label': 'dGFn' })
		cursor = delta.to

		await storageVolume.setXattr('/note.txt', 'trusted.sync.local', bytes('private'))
		expect((await replica.nodeDeltas(cursor, { limit: 10 })).operations).toEqual([])

		await storageVolume.removeXattr('/note.txt', 'user.label')
		delta = await replica.nodeDeltas(cursor, { limit: 10 })
		update = mutationsOf(delta.operations)[0]
		if (update?.kind !== 'update') throw new Error('missing xattr removal')
		expect(update.meta.xattrs).toBeUndefined()
		storage.destroy()
	})

	test('keeps putDirent insert-or-replace behavior for mapped inodes', async () => {
		const storage = idbStorage(`node-dirent-${crypto.randomUUID()}`)
		const storageVolume = volume(storage)
		await storageVolume.writeFile('/source.txt', bytes('source'))
		await storageVolume.writeFile('/destination.txt', bytes('destination'))
		const source = await storage.getDirent(storage.rootIno, 'source.txt')
		if (!source) throw new Error('missing source')

		await storage.putDirent(storage.rootIno, 'alias.txt', source)
		await storage.putDirent(storage.rootIno, 'destination.txt', source)

		const fresh = volume(storage)
		expect(text(await fresh.readFile('/alias.txt'))).toBe('source')
		expect(text(await fresh.readFile('/destination.txt'))).toBe('source')
		storage.destroy()
	})

	test('ignores unlink for an untracked putDirent alias', async () => {
		const storage = idbStorage(`node-alias-${crypto.randomUUID()}`)
		const storageVolume = volume(storage)
		const replica = nodeReplica(storage)
		await storageVolume.writeFile('/source.txt', bytes('source'))
		const cursor = (await replica.nodeDeltas('', { limit: 10 })).to
		const source = await storage.getDirent(storage.rootIno, 'source.txt')
		if (!source) throw new Error('missing source')

		await storage.putDirent(storage.rootIno, 'alias.txt', source)
		await storage.deleteDirent(storage.rootIno, 'alias.txt')

		expect((await replica.nodeDeltas(cursor, { limit: 10 })).operations).toEqual([])
		expect(text(await storageVolume.readFile('/source.txt'))).toBe('source')
		storage.destroy()
	})

	test('preserves a canonical node when a move replaces its untracked alias', async () => {
		const storage = idbStorage(`node-alias-move-${crypto.randomUUID()}`)
		const storageVolume = volume(storage)
		const replica = nodeReplica(storage)
		await storageVolume.writeFile('/source.txt', bytes('source'))
		await storageVolume.writeFile('/moving.txt', bytes('moving'))
		const cursor = (await replica.nodeDeltas('', { limit: 10 })).to
		const source = await storage.getDirent(storage.rootIno, 'source.txt')
		if (!source) throw new Error('missing source')

		await storage.putDirent(storage.rootIno, 'alias.txt', source)
		await storageVolume.rename('/moving.txt', '/alias.txt')

		expect(mutationsOf((await replica.nodeDeltas(cursor, { limit: 10 })).operations)).toEqual([
			expect.objectContaining({ kind: 'move', name: 'alias.txt' })
		])
		expect(text(await storageVolume.readFile('/source.txt'))).toBe('source')
		expect(text(await storageVolume.readFile('/alias.txt'))).toBe('moving')
		storage.destroy()
	})

	test('ignores a move from an untracked putDirent alias', async () => {
		const storage = idbStorage(`node-alias-source-${crypto.randomUUID()}`)
		const storageVolume = volume(storage)
		const replica = nodeReplica(storage)
		await storageVolume.writeFile('/source.txt', bytes('source'))
		const cursor = (await replica.nodeDeltas('', { limit: 10 })).to
		const source = await storage.getDirent(storage.rootIno, 'source.txt')
		if (!source) throw new Error('missing source')

		await storage.putDirent(storage.rootIno, 'alias.txt', source)
		await storageVolume.rename('/alias.txt', '/renamed.txt')

		expect((await replica.nodeDeltas(cursor, { limit: 10 })).operations).toEqual([])
		expect(text(await storageVolume.readFile('/source.txt'))).toBe('source')
		expect(text(await storageVolume.readFile('/renamed.txt'))).toBe('source')
		storage.destroy()
	})

	test('does not echo pulled moves', async () => {
		const sourceStorage = nodeMemStorage()
		const sourceVolume = volume(sourceStorage)
		const source = nodeReplica(sourceStorage)
		const targetStorage = idbStorage(`node-echo-${crypto.randomUUID()}`)
		const target = nodeReplica(targetStorage)
		await sourceVolume.mkdir('/old/tree', { recursive: true })
		await sourceVolume.mkdir('/new')

		let outgoing = await source.nodeDeltas('', { limit: 10 })
		await target.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash), {
			source: 'remote'
		})
		const cursor = (await target.nodeDeltas('', { limit: 10 })).to
		const sourceCursor = outgoing.to

		await sourceVolume.rename('/old/tree', '/new/tree')
		outgoing = await source.nodeDeltas(sourceCursor, { limit: 10 })
		await target.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash), {
			source: 'remote'
		})

		const nextPush = await target.nodeDeltas(cursor, {
			excludeLocalSource: 'remote',
			limit: 10
		})
		expect(nextPush.operations).toEqual([])
		expect(nextPush.to).not.toBe(cursor)
		targetStorage.destroy()
	})

	test('keeps a pulled tombstone across restart and gives path reuse a new ID', async () => {
		const name = `node-delete-${crypto.randomUUID()}`
		const first = idbStorage(name)
		const firstReplica = nodeReplica(first)
		const create = {
			mutations: [
				{
					kind: 'create' as const,
					nodeId: 'old-note',
					parentId: ROOT_NODE_ID,
					name: 'note.txt',
					revision: 1,
					meta: { type: FileType.Regular, mode: 0o644, mtimeNs: '0', size: '3' },
					contentHash: '7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed'
				}
			]
		}
		await firstReplica.applyNodeOperations([create], async () => bytes('one'), { source: 'remote' })
		await firstReplica.applyNodeOperations(
			[{ mutations: [{ kind: 'delete', nodeId: 'old-note', revision: 2 }] }],
			() => Promise.reject(new Error('delete requested content')),
			{ source: 'remote' }
		)
		const cursor = (await firstReplica.nodeDeltas('', { limit: 10 })).to
		first.destroy()

		const second = idbStorage(name)
		const secondReplica = nodeReplica(second)
		await secondReplica.applyNodeOperations([create], async () => bytes('one'))
		expect(await volume(second).exists('/note.txt')).toBe(false)

		await volume(second).writeFile('/note.txt', bytes('new'))
		const fresh = mutationsOf((await secondReplica.nodeDeltas(cursor, { limit: 10 })).operations)
		const newId = fresh.find(
			(mutation) => mutation.kind === 'create' && mutation.name === 'note.txt'
		)?.nodeId
		expect(newId).toBeTruthy()
		expect(newId).not.toBe('old-note')
		second.destroy()
	})

	test('eagerly materializes content when caps.content is hidden', async () => {
		const sourceStorage = nodeMemStorage()
		const source = nodeReplica(sourceStorage)
		await volume(sourceStorage).writeFile('/note.txt', bytes('ordinary bytes'))
		const targetStorage = idbStorage(`node-ordinary-${crypto.randomUUID()}`)
		const target = nodeReplica(hideContent(targetStorage))
		const outgoing = await source.nodeDeltas('', { limit: 10 })

		await target.applyNodeOperations(outgoing.operations, (hash) => source.getBlobByHash(hash))

		expect(text(await volume(targetStorage).readFile('/note.txt'))).toBe('ordinary bytes')
		targetStorage.destroy()
	})

	test('captures ordinary delta content in the journal read transaction', async () => {
		const storage = idbStorage(`node-delta-content-${crypto.randomUUID()}`)
		const storageVolume = volume(storage)
		const oldData = bytes('old')
		const newData = bytes('new')
		await storageVolume.writeFile('/note.txt', oldData)
		const ino = (await storageVolume.lstat('/note.txt')).ino
		const newHash = await hashBytes(newData)
		const content = storage.caps.content
		if (!content) throw new Error('missing content capability')
		await content.putByHash(newHash, newData)
		const replica = nodeReplica(hideContent(storage))

		const original = IDBObjectStore.prototype.openCursor
		let armed = true
		let updating = Promise.resolve()
		const interleave = vi
			.spyOn(IDBObjectStore.prototype, 'openCursor')
			.mockImplementation(function (
				this: IDBObjectStore,
				query?: IDBValidKey | IDBKeyRange | null,
				direction?: IDBCursorDirection
			) {
				const request = original.call(this, query, direction)
				if (armed && this.name === 'nodeJournal') {
					armed = false
					updating = storage.setMeta(ino, {
						contentHash: newHash,
						size: BigInt(newData.length)
					})
				}
				return request
			} as typeof original)

		try {
			const delta = await replica.nodeDeltas('', { limit: 10 })
			await updating
			const oldHash = mutationsOf(delta.operations).find(
				(mutation) => mutation.kind === 'create'
			)?.contentHash
			if (!oldHash) throw new Error('missing old content hash')
			expect(await replica.getBlobByHash(oldHash)).toEqual(oldData)
			expect(text(await storageVolume.readFile('/note.txt'))).toBe('new')
		} finally {
			interleave.mockRestore()
			await updating
			storage.destroy()
		}
	})

	test('does not capture evicted content from an excluded remote row', async () => {
		const remoteStorage = nodeMemStorage()
		const remote = nodeReplica(remoteStorage)
		await volume(remoteStorage).writeFile('/remote.txt', bytes('remote'))
		const pulled = await remote.nodeDeltas('', { limit: 10 })
		const remoteHash = mutationsOf(pulled.operations).find(
			(mutation) => mutation.kind === 'create'
		)?.contentHash
		if (!remoteHash) throw new Error('missing remote content hash')

		const storage = idbStorage(`node-excluded-content-${crypto.randomUUID()}`, {
			contentCapBytes: 6
		})
		const replica = nodeReplica(storage)
		await replica.applyNodeOperations(pulled.operations, (hash) => remote.getBlobByHash(hash), {
			source: 'remote'
		})
		const content = storage.caps.content
		if (!content) throw new Error('missing content capability')
		const localData = bytes('local!')
		await volume(storage).writeFile('/local.txt', localData)
		expect(await content.hasByHash(remoteHash)).toBe(false)

		const ordinary = nodeReplica(hideContent(storage))
		const delta = await ordinary.nodeDeltas('', {
			excludeLocalSource: 'remote',
			limit: 10
		})
		const local = mutationsOf(delta.operations)
		expect(local).toEqual([expect.objectContaining({ kind: 'create', name: 'local.txt' })])
		const localHash = local[0]?.kind === 'create' ? local[0].contentHash : undefined
		if (!localHash) throw new Error('missing local content hash')
		expect(await ordinary.getBlobByHash(localHash)).toEqual(localData)
		expect(delta.to).not.toBe('')
		storage.destroy()
	})

	test('moves 4,000 descendants with one node row and no content read', async () => {
		const storage = idbStorage(`node-move-${crypto.randomUUID()}`)
		const storageVolume = volume(storage)
		const replica = nodeReplica(storage)
		await storageVolume.mkdir('/old/tree', { recursive: true })
		await storageVolume.mkdir('/new')
		for (let index = 0; index < 4000; index++)
			await storageVolume.writeFile(`/old/tree/f${index}.txt`, bytes('same'))
		const initial = await replica.nodeDeltas('', { limit: 10_000 })
		const cursor = initial.to
		const targetStorage = idbStorage(`node-move-target-${crypto.randomUUID()}`)
		const target = nodeReplica(targetStorage)
		await target.applyNodeOperations(initial.operations, (hash) => replica.getBlobByHash(hash))

		await storageVolume.rename('/old/tree', '/new/tree')
		const outgoing = await replica.nodeDeltas(cursor, { limit: 10 })

		expect(outgoing.operations).toHaveLength(1)
		expect(outgoing.operations[0]?.mutations).toEqual([
			expect.objectContaining({ kind: 'move', name: 'tree' })
		])
		const getBlob = vi.fn((hash: string) => replica.getBlobByHash(hash))
		await target.applyNodeOperations(outgoing.operations, getBlob)
		expect(getBlob).not.toHaveBeenCalled()
		expect(text(await volume(targetStorage).readFile('/new/tree/f3999.txt'))).toBe('same')
		expect(await volume(targetStorage).exists('/old/tree')).toBe(false)
		targetStorage.destroy()
		storage.destroy()
	}, 30_000)

	test('rolls back tree, mapping, state, and journal writes together', async () => {
		const name = `node-abort-${crypto.randomUUID()}`
		const storage = idbStorage(name)
		const storageVolume = volume(storage)
		const replica = nodeReplica(storage)
		await storageVolume.mkdir('/source')
		await storageVolume.mkdir('/target')
		await storageVolume.writeFile('/update.txt', bytes('old'))
		await storageVolume.writeFile('/delete.txt', bytes('delete'))
		const cursor = (await replica.nodeDeltas('', { limit: 100 })).to

		await abortNextNodeJournalWrite(() => storageVolume.mkdir('/rolled-back'))
		await abortNextNodeJournalWrite(() => storageVolume.rename('/source', '/target/moved'))
		await abortNextNodeJournalWrite(() => storageVolume.writeFile('/update.txt', bytes('new')))
		await abortNextNodeJournalWrite(() => storageVolume.rm('/delete.txt'))
		storage.destroy()

		const reopened = idbStorage(name)
		const reopenedVolume = volume(reopened)
		expect(await reopenedVolume.exists('/rolled-back')).toBe(false)
		expect(await reopenedVolume.exists('/source')).toBe(true)
		expect(await reopenedVolume.exists('/target/moved')).toBe(false)
		expect(text(await reopenedVolume.readFile('/update.txt'))).toBe('old')
		expect(text(await reopenedVolume.readFile('/delete.txt'))).toBe('delete')
		const delta = await nodeReplica(reopened).nodeDeltas(cursor, { limit: 100 })
		expect(delta.operations).toEqual([])
		expect(delta.to).toBe(cursor)
		reopened.destroy()
	})

	test('keeps lazy path content readable after an ancestor move', async () => {
		const peers = twoPeers({
			lazyContent: true,
			makeBackend: (options) =>
				idbStorage(`node-lazy-${crypto.randomUUID()}`, {
					localActorId: options?.localActorId
				})
		})
		await peers.server.writeFile('/old/tree/note.txt', bytes('lazy bytes'))
		await peers.syncBoth()
		await peers.client.mkdir('/new')
		await peers.client.rename('/old/tree', '/new/tree')
		const before = await peers.client.replica.pathDeltas('', { limit: 1000 })
		const contentHash = (await peers.client.stat('/new/tree/note.txt')).contentHash

		expect(text(await peers.client.readFile('/new/tree/note.txt'))).toBe('lazy bytes')
		expect((await peers.client.stat('/new/tree/note.txt')).contentHash).toBe(contentHash)
		expect((await peers.client.replica.pathDeltas(before.to, { limit: 10 })).changes).toEqual([])
	})
})
