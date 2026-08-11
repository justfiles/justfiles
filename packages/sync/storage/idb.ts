import {
	type IdbStorage as FilesystemIdbStorage,
	idbStorage as filesystemStorage,
	type IdbStorageExtension
} from '@justfiles/fs/storage/idb'
import type { DBSchema, IDBPDatabase, IDBPObjectStore, IDBPTransaction, StoreNames } from 'idb'
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

interface SyncSchema extends DBSchema {
	journal: {
		key: number
		value: JournalRecord
		indexes: { 'by-path': string }
	}
	pathver: { key: string; value: PathVersionRecord }
}

type JournalStoreOf<Mode extends 'readwrite' | 'versionchange'> = IDBPObjectStore<
	SyncSchema,
	ArrayLike<StoreNames<SyncSchema>>,
	'journal',
	Mode
>
type SyncTx = IDBPTransaction<SyncSchema, ('journal' | 'pathver')[], 'readwrite'>
type UpgradeTx = IDBPTransaction<SyncSchema, ('journal' | 'pathver')[], 'versionchange'>

const VERSION = 7

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

export type IdbStorage = JournaledStorage & Pick<FilesystemIdbStorage, 'destroy'>

export function idbStorage(
	dbName: string,
	options?: { contentCapBytes?: number; localActorId?: string }
): IdbStorage {
	const actorId = options?.localActorId ?? 'local'
	const extension: IdbStorageExtension<{ sync: JournaledSyncModule }> = {
		version: VERSION,
		stores: ['journal', 'pathver'],
		async upgrade(database, _oldVersion, transaction) {
			const db = database as IDBPDatabase<SyncSchema>
			if (!db.objectStoreNames.contains('journal'))
				db.createObjectStore('journal', { keyPath: 'seq', autoIncrement: true })
			if (!db.objectStoreNames.contains('pathver'))
				db.createObjectStore('pathver', { keyPath: 'path' })

			const tx = transaction as UpgradeTx
			const journal = tx.objectStore('journal')
			if (!journal.indexNames.contains('by-path')) journal.createIndex('by-path', 'change.path')
			await coalesceJournal(journal)
		},
		async record(transaction, tree, effect, mutationOptions) {
			await pathSyncObserver(syncStore(transaction), actorId).record(tree, effect, mutationOptions)
		},
		attach(host) {
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
				}
			}
		}
	}

	return filesystemStorage(dbName, {
		contentCapBytes: options?.contentCapBytes,
		extension
	})
}
