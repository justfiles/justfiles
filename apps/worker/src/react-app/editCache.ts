import { type DBSchema, type IDBPDatabase, openDB as idbOpenDB } from 'idb'
import type { Node as ProseMirrorNode } from 'prosemirror-model'

export type ProseMirrorJsonDocument = ReturnType<ProseMirrorNode['toJSON']>

export interface EditCache {
	get(docId: string): Promise<ProseMirrorJsonDocument | null>
	put(docId: string, doc: ProseMirrorJsonDocument): Promise<void>
	delete(docId: string): Promise<void>
	destroy(): void
}

interface DraftRecord {
	docId: string
	doc: ProseMirrorJsonDocument
	savedAt: number
}

interface EditCacheDB extends DBSchema {
	drafts: {
		key: string
		value: DraftRecord
	}
}

const DB_NAME = 'justfiles-edit-cache'
const DB_VERSION = 1

export async function openEditCache(): Promise<EditCache> {
	let dbPromise: Promise<IDBPDatabase<EditCacheDB>> | null = idbOpenDB<EditCacheDB>(
		DB_NAME,
		DB_VERSION,
		{
			upgrade(db) {
				db.createObjectStore('drafts', { keyPath: 'docId' })
			}
		}
	)
	let destroyed = false

	async function getDb(): Promise<IDBPDatabase<EditCacheDB>> {
		if (destroyed || dbPromise === null) {
			throw new Error('EditCache is destroyed')
		}
		return dbPromise
	}

	return {
		async get(docId) {
			const db = await getDb()
			const record = await db.get('drafts', docId)
			return record?.doc ?? null
		},

		async put(docId, doc) {
			const db = await getDb()
			await db.put('drafts', {
				docId,
				doc,
				savedAt: Date.now()
			})
		},

		async delete(docId) {
			const db = await getDb()
			await db.delete('drafts', docId)
		},

		destroy() {
			destroyed = true
			const current = dbPromise
			dbPromise = null
			void current?.then((db) => db.close()).catch(() => {})
		}
	}
}
