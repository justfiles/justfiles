import {
	type IdbStorage as FilesystemIdbStorage,
	idbStorage as filesystemStorage,
	type IdbStorageExtension,
	type IdbStorageExtensionHost
} from '@justfiles/fs/storage/idb'
import { FileType } from '@justfiles/fs/types'
import type { DBSchema, IDBPDatabase, IDBPObjectStore, IDBPTransaction, StoreNames } from 'idb'
import { verifyBytes } from '../content'
import {
	acceptNodeOperationsOver,
	applyNodeOperationsOver,
	compactNodeJournal,
	createSyncCapability,
	mutationsOf,
	type NodeJournalRow,
	type NodeOperation,
	type NodeOperationResult,
	type NodeState,
	type NodeStore,
	type NodeSyncModule,
	nodeSyncObserver,
	reconcileNodeSnapshotOver,
	type SyncCapableStorage,
	withSyncCapability
} from '../node'
import { nodeSnapshotEntries } from '../node-snapshot'
import { applyJournaledOver, localChangeOver, type PathSyncStore, pathSyncObserver } from '../path'
import type { JournaledStorage, JournaledSyncModule, JournalRow } from '../replica'
import { coalesceByPath, type PathChange } from '../wire'

interface JournalRecord {
	seq?: number
	change: PathChange
	localSource?: string
}

interface PathVersionRecord {
	path: string
	version: number
	tombstone: number
}

interface NodeJournalRecord {
	seq: number
	operation: NodeOperation
	localSource?: string
	nodeIds: string[]
}

interface NodeClockRecord {
	id: 'clock'
	head: number
}

interface NodeOperationRecord {
	operationId: string
	request: string
	result: NodeOperationResult
}

interface ContentRecord {
	contentHash: string
	data: Uint8Array
	sizeBytes: number
	lastAccessedAt: number
}

interface SyncSchema extends DBSchema {
	journal: {
		key: number
		value: JournalRecord
		indexes: { 'by-path': string }
	}
	pathver: { key: string; value: PathVersionRecord }
	syncNodes: {
		key: string
		value: NodeState
		indexes: { 'by-local-ino': string }
	}
	nodeJournal: {
		key: number
		value: NodeJournalRecord
		indexes: { 'by-node': string }
	}
	nodeClock: { key: string; value: NodeClockRecord }
	nodeOperations: { key: string; value: NodeOperationRecord }
	content: {
		key: string
		value: ContentRecord
		indexes: { 'by-lru': number }
	}
}

type JournalStoreOf<Mode extends 'readwrite' | 'versionchange'> = IDBPObjectStore<
	SyncSchema,
	ArrayLike<StoreNames<SyncSchema>>,
	'journal',
	Mode
>
type SyncTx = IDBPTransaction<SyncSchema, ('journal' | 'pathver')[], 'readwrite'>
type UpgradeTx = IDBPTransaction<
	SyncSchema,
	('journal' | 'pathver' | 'syncNodes' | 'nodeJournal' | 'nodeClock' | 'nodeOperations')[],
	'versionchange'
>
type NodeTx = IDBPTransaction<
	SyncSchema,
	('syncNodes' | 'nodeJournal' | 'nodeClock' | 'nodeOperations')[],
	'readwrite'
>
type SnapshotTx = IDBPTransaction<
	SyncSchema,
	('syncNodes' | 'nodeJournal' | 'nodeClock' | 'nodeOperations' | 'content')[],
	'readwrite'
>

const VERSION = 9
const NODE_STORES = ['syncNodes', 'nodeJournal', 'nodeClock', 'nodeOperations'] as const
const ALL_STORES = [
	'inodes',
	'content',
	'dirs',
	'xattrs',
	'dirty',
	'meta',
	'journal',
	'pathver',
	...NODE_STORES
] as const

async function appendJournalRow(
	journal: JournalStoreOf<'readwrite'>,
	change: PathChange,
	localSource?: string
): Promise<void> {
	const seq = await journal.add({ change, localSource })
	let cursor = await journal.index('by-path').openCursor(change.path)
	while (cursor && cursor.primaryKey < seq) {
		await cursor.delete()
		cursor = await cursor.continue()
	}
}

async function coalesceJournal(journal: JournalStoreOf<'versionchange'>): Promise<void> {
	const latest = new Map<string, number>()
	let cursor = await journal.openCursor()
	while (cursor) {
		latest.set(cursor.value.change.path, cursor.key)
		cursor = await cursor.continue()
	}
	cursor = await journal.openCursor()
	while (cursor) {
		if (latest.get(cursor.value.change.path) !== cursor.key) await cursor.delete()
		cursor = await cursor.continue()
	}
}

function syncStore(transaction: unknown): PathSyncStore {
	const tx = transaction as SyncTx
	return {
		async readPathVersion(path) {
			const record = await tx.objectStore('pathver').get(path)
			return { version: record?.version ?? 0, tombstone: record?.tombstone ?? 0 }
		},
		async setPathVersion(path, version, tombstone) {
			await tx.objectStore('pathver').put({ path, version, tombstone })
		},
		async appendJournalRow(change, localSource) {
			await appendJournalRow(tx.objectStore('journal'), change, localSource)
		}
	}
}

function nodeIds(operation: NodeOperation): string[] {
	return [...new Set(operation.mutations.map((mutation) => mutation.nodeId))]
}

function nodeStore(transaction: unknown): NodeStore {
	const tx = transaction as NodeTx
	return {
		async get(id) {
			return (await tx.objectStore('syncNodes').get(id)) ?? null
		},
		async idFor(ino) {
			return (await tx.objectStore('syncNodes').index('by-local-ino').getKey(ino)) ?? null
		},
		async at(parentId, name) {
			return (
				(await tx.objectStore('syncNodes').getAll()).find(
					(state) => !state.deleted && state.parentId === parentId && state.name === name
				) ?? null
			)
		},
		async live() {
			return (await tx.objectStore('syncNodes').getAll()).filter((state) => !state.deleted)
		},
		async save(state) {
			await tx.objectStore('syncNodes').put(state)
		},
		async remove(id) {
			await tx.objectStore('syncNodes').delete(id)
		},
		async append(operation, localSource) {
			const journal = tx.objectStore('nodeJournal')
			const affected = [
				...new Set(
					operation.mutations.flatMap((mutation) =>
						mutation.kind === 'update' || mutation.kind === 'delete' ? [mutation.nodeId] : []
					)
				)
			]
			const keys = new Set<number>()
			for (const id of affected)
				for (const key of await journal.index('by-node').getAllKeys(id)) keys.add(key)

			const stored = (
				await Promise.all([...keys].sort((a, b) => a - b).map((key) => journal.get(key)))
			).filter((row): row is NodeJournalRecord => row !== undefined)
			if (stored.length > 0) {
				const rows = stored.map(
					(row): NodeJournalRow => ({
						seq: row.seq,
						operation: row.operation,
						localSource: row.localSource
					})
				)
				const directoryTombstones = new Set<string>()
				for (const mutation of operation.mutations) {
					if (mutation.kind !== 'delete') continue
					const state = await tx.objectStore('syncNodes').get(mutation.nodeId)
					if (state?.type === FileType.Directory) directoryTombstones.add(mutation.nodeId)
				}
				const compacted = new Map(
					compactNodeJournal(rows, operation, directoryTombstones).map((row) => [row.seq, row])
				)
				for (const row of rows) {
					const next = compacted.get(row.seq)
					if (next === row) continue
					if (!next) {
						await journal.delete(row.seq)
						continue
					}
					await journal.put({
						seq: next.seq,
						operation: next.operation,
						localSource: next.localSource,
						nodeIds: nodeIds(next.operation)
					})
				}
			}

			const clock = tx.objectStore('nodeClock')
			const seq = ((await clock.get('clock'))?.head ?? 0) + 1
			await clock.put({ id: 'clock', head: seq })
			await journal.put({ seq, operation, localSource, nodeIds: nodeIds(operation) })
		},
		async getOperation(operationId) {
			const record = await tx.objectStore('nodeOperations').get(operationId)
			return record ? { request: record.request, result: record.result } : null
		},
		async saveOperation(operationId, request, result) {
			await tx.objectStore('nodeOperations').put({ operationId, request, result })
		},
		async read(after, limit) {
			const out: NodeJournalRow[] = []
			let cursor = await tx.objectStore('nodeJournal').openCursor(IDBKeyRange.lowerBound(after + 1))
			while (cursor && out.length < limit) {
				out.push({
					seq: cursor.value.seq,
					operation: cursor.value.operation,
					localSource: cursor.value.localSource
				})
				cursor = await cursor.continue()
			}
			return out
		},
		async head() {
			return (await tx.objectStore('nodeClock').get('clock'))?.head ?? 0
		}
	}
}

function durableNodeStore(host: IdbStorageExtensionHost): NodeStore {
	return {
		get: (id) => host.run(NODE_STORES, (transaction) => nodeStore(transaction).get(id)),
		idFor: (ino) => host.run(NODE_STORES, (transaction) => nodeStore(transaction).idFor(ino)),
		at: (parentId, name) =>
			host.run(NODE_STORES, (transaction) => nodeStore(transaction).at(parentId, name)),
		live: () => host.run(NODE_STORES, (transaction) => nodeStore(transaction).live()),
		save: (state) => host.run(NODE_STORES, (transaction) => nodeStore(transaction).save(state)),
		remove: (id) => host.run(NODE_STORES, (transaction) => nodeStore(transaction).remove(id)),
		append: (operation, localSource) =>
			host.run(NODE_STORES, (transaction) => nodeStore(transaction).append(operation, localSource)),
		getOperation: (operationId) =>
			host.run(NODE_STORES, (transaction) => nodeStore(transaction).getOperation(operationId)),
		saveOperation: (operationId, request, result) =>
			host.run(NODE_STORES, (transaction) =>
				nodeStore(transaction).saveOperation(operationId, request, result)
			),
		read: (after, limit) =>
			host.run(NODE_STORES, (transaction) => nodeStore(transaction).read(after, limit)),
		head: () => host.run(NODE_STORES, (transaction) => nodeStore(transaction).head())
	}
}

async function readBlobs(
	transaction: unknown,
	hashes: Iterable<string>,
	label: string
): Promise<Map<string, Uint8Array>> {
	const content = (transaction as SnapshotTx).objectStore('content')
	const raw = new Map<string, Uint8Array>()
	for (const hash of hashes) {
		const record = await content.get(hash)
		if (!record) throw new Error(`ENOENT: ${label} ${hash}`)
		raw.set(hash, record.data.slice())
	}
	const blobs = new Map<string, Uint8Array>()
	for (const [hash, blob] of raw) blobs.set(hash, await verifyBytes(hash, blob))
	return blobs
}

export type IdbStorage = JournaledStorage &
	SyncCapableStorage &
	Pick<FilesystemIdbStorage, 'destroy'>

export function idbStorage(
	dbName: string,
	options?: { contentCapBytes?: number; localActorId?: string }
): IdbStorage {
	const actorId = options?.localActorId ?? 'local'
	let localIgnore: readonly string[] = []
	let filesystem!: FilesystemIdbStorage
	const extension: IdbStorageExtension<{ sync: JournaledSyncModule; node: NodeSyncModule }> = {
		version: VERSION,
		stores: ['journal', 'pathver', ...NODE_STORES],
		async upgrade(database, _oldVersion, transaction) {
			const db = database as IDBPDatabase<SyncSchema>
			if (!db.objectStoreNames.contains('journal'))
				db.createObjectStore('journal', { keyPath: 'seq', autoIncrement: true })
			if (!db.objectStoreNames.contains('pathver'))
				db.createObjectStore('pathver', { keyPath: 'path' })
			if (!db.objectStoreNames.contains('syncNodes')) {
				const nodes = db.createObjectStore('syncNodes', { keyPath: 'id' })
				nodes.createIndex('by-local-ino', 'localIno', { unique: true })
			}
			if (!db.objectStoreNames.contains('nodeJournal')) {
				const journal = db.createObjectStore('nodeJournal', { keyPath: 'seq' })
				journal.createIndex('by-node', 'nodeIds', { multiEntry: true })
			}
			if (!db.objectStoreNames.contains('nodeClock'))
				db.createObjectStore('nodeClock', { keyPath: 'id' })
			if (!db.objectStoreNames.contains('nodeOperations'))
				db.createObjectStore('nodeOperations', { keyPath: 'operationId' })

			const tx = transaction as UpgradeTx
			const journal = tx.objectStore('journal')
			if (!journal.indexNames.contains('by-path')) journal.createIndex('by-path', 'change.path')
			await coalesceJournal(journal)
			if (!(await tx.objectStore('nodeClock').get('clock')))
				await tx.objectStore('nodeClock').put({ id: 'clock', head: 0 })
		},
		async record(transaction, tree, effect, mutationOptions) {
			await pathSyncObserver(syncStore(transaction), actorId).record(tree, effect, mutationOptions)
			await nodeSyncObserver(nodeStore(transaction), () => localIgnore).record(
				tree,
				effect,
				mutationOptions
			)
		},
		attach(host) {
			const nodes = durableNodeStore(host)
			return {
				sync: {
					clearSyncState: () =>
						host.run(['journal', 'pathver'], async (transaction) => {
							const tx = transaction as SyncTx
							await tx.objectStore('journal').clear()
							await tx.objectStore('pathver').clear()
						}),
					journal: {
						append: (changes, localSource) =>
							host.run(['journal'], async (transaction) => {
								const journal = (transaction as SyncTx).objectStore('journal')
								for (const change of changes) await appendJournalRow(journal, change, localSource)
							}),
						readFrom: (seq, limit) =>
							host.run(['journal'], async (transaction) => {
								const out: JournalRow[] = []
								let cursor = await (transaction as SyncTx)
									.objectStore('journal')
									.openCursor(IDBKeyRange.lowerBound(seq + 1))
								while (cursor && out.length < limit) {
									out.push({
										seq: cursor.key,
										change: cursor.value.change,
										localSource: cursor.value.localSource
									})
									cursor = await cursor.continue()
								}
								return out
							}),
						head: () =>
							host.run(['journal'], async (transaction) => {
								const cursor = await (transaction as SyncTx)
									.objectStore('journal')
									.openCursor(null, 'prev')
								return cursor?.key ?? 0
							}),
						adoptAllAsLocal: (adoptOptions) =>
							host.run(['journal'], async (transaction) => {
								const journal = (transaction as SyncTx).objectStore('journal')
								const current = coalesceByPath(
									(await journal.getAll()).map((row) => row.change)
								).filter((change) => !adoptOptions?.dropDeletes || change.kind === 'put')
								await journal.clear()
								for (const change of current) await journal.add({ change })
							})
					},
					pathApply: {
						localChange: (path) =>
							host.run(['dirs', 'inodes', 'xattrs', 'pathver'], (transaction, tree) =>
								localChangeOver(tree, syncStore(transaction), path, actorId)
							),
						applyJournaled: (changes, applyOptions) =>
							host.run(['dirs', 'inodes', 'xattrs', 'pathver', 'journal'], (transaction, tree) =>
								applyJournaledOver(tree, syncStore(transaction), changes, applyOptions)
							)
					}
				},
				node: {
					nodes,
					setLocalIgnore(ignore) {
						localIgnore = ignore
					},
					captureDeltas: (after, limit, include) =>
						host.run([...NODE_STORES, 'content'], async (transaction) => {
							const rows = await nodeStore(transaction).read(after, limit)
							const hashes = new Set<string>()
							for (const mutation of mutationsOf(rows.filter(include).map((row) => row.operation)))
								if (
									(mutation.kind === 'create' || mutation.kind === 'update') &&
									mutation.contentHash
								)
									hashes.add(mutation.contentHash)
							const retainedContent = await readBlobs(transaction, hashes, 'blob')
							return { rows, retainedContent }
						}),
					async apply(operations, applyOptions) {
						const content = filesystem.caps?.content
						if (!content) throw new Error('IndexedDB backend exposes no content store')
						for (const [hash, data] of applyOptions?.content ?? [])
							await content.putByHash(hash, data)
						await host.run(ALL_STORES, (transaction, tree) =>
							applyNodeOperationsOver(tree, nodeStore(transaction), operations, applyOptions)
						)
					},
					async accept(operations, applyOptions) {
						const content = filesystem.caps?.content
						if (!content) throw new Error('IndexedDB backend exposes no content store')
						for (const [hash, data] of applyOptions?.content ?? [])
							await content.putByHash(hash, data)
						return host.run(ALL_STORES, (transaction, tree) =>
							acceptNodeOperationsOver(tree, nodeStore(transaction), operations, applyOptions)
						)
					},
					async reconcile(operations, ignore, applyOptions) {
						const content = filesystem.caps?.content
						if (!content) throw new Error('IndexedDB backend exposes no content store')
						for (const [hash, data] of applyOptions?.content ?? [])
							await content.putByHash(hash, data)
						await host.run(ALL_STORES, (transaction, tree) =>
							reconcileNodeSnapshotOver(
								tree,
								nodeStore(transaction),
								operations,
								ignore,
								applyOptions
							)
						)
					},
					openSnapshotView: () =>
						host.run(ALL_STORES, async (transaction, tree) => {
							const nodes = nodeStore(transaction)
							await applyNodeOperationsOver(tree, nodes, [])
							const live = await nodes.live()
							const entries = nodeSnapshotEntries(live)
							const syncCursor = String(await nodes.head())
							const blobs = await readBlobs(
								transaction,
								new Set(live.flatMap((node) => (node.contentHash ? [node.contentHash] : []))),
								'snapshot blob'
							)
							return {
								entries,
								syncCursor,
								async getBlob(hash: string) {
									const blob = blobs.get(hash)
									if (!blob) throw new Error(`ENOENT: snapshot blob ${hash}`)
									return blob.slice()
								},
								async close() {
									blobs.clear()
								}
							}
						})
				}
			}
		}
	}

	const attached = filesystemStorage(dbName, {
		contentCapBytes: options?.contentCapBytes,
		extension
	})
	filesystem = attached
	const { node, ...storage } = attached
	return withSyncCapability(storage, createSyncCapability(storage, node)) as IdbStorage
}
