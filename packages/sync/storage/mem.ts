import {
	memStorage as filesystemStorage,
	type MemStorageExtension
} from '@justfiles/fs/storage/mem'
import type { Ino } from '@justfiles/fs/types'
import { applyJournaledOver, localChangeOver, type PathSyncStore, pathSyncObserver } from '../path'
import type { JournaledStorage, JournaledSyncModule, JournalRow } from '../replica'
import { coalesceByPath, type PathChange } from '../wire'

export function memStorage(opts?: {
	mintIno?: () => Ino
	localActorId?: string
}): JournaledStorage {
	const actorId = opts?.localActorId ?? 'local'
	const pathVersion = new Map<string, number>()
	const tombstone = new Map<string, number>()
	const journalRows: JournalRow[] = []
	let journalSeq = 0

	function appendJournal(changes: PathChange[], localSource?: string): void {
		for (const change of changes) {
			journalSeq += 1
			const superseded = journalRows.findIndex((row) => row.change.path === change.path)
			if (superseded >= 0) journalRows.splice(superseded, 1)
			journalRows.push({ seq: journalSeq, change, localSource })
		}
	}

	const store: PathSyncStore = {
		async readPathVersion(path) {
			return { version: pathVersion.get(path) ?? 0, tombstone: tombstone.get(path) ?? 0 }
		},
		async setPathVersion(path, version, deletedAt) {
			pathVersion.set(path, version)
			tombstone.set(path, deletedAt)
		},
		async appendJournalRow(change, localSource) {
			appendJournal([change], localSource)
		}
	}

	const extension: MemStorageExtension<{ sync: JournaledSyncModule }> = {
		observer: pathSyncObserver(store, actorId),
		attach(tree) {
			return {
				sync: {
					async clearSyncState() {
						pathVersion.clear()
						tombstone.clear()
						journalRows.length = 0
						journalSeq = 0
					},
					journal: {
						async append(changes, localSource) {
							appendJournal(changes, localSource)
						},
						async readFrom(seq, limit) {
							return journalRows.filter((row) => row.seq > seq).slice(0, limit)
						},
						async head() {
							return journalSeq
						},
						async adoptAllAsLocal(options) {
							const current = coalesceByPath(journalRows.map((row) => row.change)).filter(
								(change) => !options?.dropDeletes || change.kind === 'put'
							)
							journalRows.length = 0
							appendJournal(current)
						}
					},
					pathApply: {
						localChange: (path) => localChangeOver(tree, store, path, actorId),
						applyJournaled: (changes, options) => applyJournaledOver(tree, store, changes, options)
					}
				}
			}
		}
	}

	return filesystemStorage({ mintIno: opts?.mintIno, extension })
}
