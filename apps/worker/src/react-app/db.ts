import { type DBSchema, type IDBPDatabase, openDB as idbOpenDB } from 'idb'

export interface PendingPatch {
	id: string
	documentId: string
	kind: 'content' | 'title' | 'path'
	value: string
	savedAt: number
}

interface JustfilesDB extends DBSchema {
	'pending-patches': {
		key: string
		value: PendingPatch
		indexes: {
			'by-documentId': string
			'by-savedAt': number
		}
	}
}

let dbPromise: Promise<IDBPDatabase<JustfilesDB>> | null = null

function createPatchId(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
		return crypto.randomUUID()
	}
	return `patch_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

export function openDB(): Promise<IDBPDatabase<JustfilesDB>> {
	if (!dbPromise) {
		dbPromise = idbOpenDB<JustfilesDB>('justfiles-db', 1, {
			upgrade(db) {
				const patches = db.createObjectStore('pending-patches', { keyPath: 'id' })
				patches.createIndex('by-documentId', 'documentId')
				patches.createIndex('by-savedAt', 'savedAt')
			}
		})
	}
	return dbPromise
}

export async function appendPendingPatch(
	patch: Omit<PendingPatch, 'id'> & { id?: string }
): Promise<string> {
	const db = await openDB()
	const id = patch.id ?? createPatchId()
	await db.put('pending-patches', { ...patch, id })
	return id
}

export async function getPendingPatches(documentId: string): Promise<PendingPatch[]> {
	const db = await openDB()
	return db.getAllFromIndex('pending-patches', 'by-documentId', documentId)
}

export async function getAllPendingPatches(): Promise<PendingPatch[]> {
	const db = await openDB()
	return db.getAll('pending-patches')
}

export async function deletePendingPatches(ids: string[]): Promise<void> {
	if (ids.length === 0) return
	const db = await openDB()
	const tx = db.transaction('pending-patches', 'readwrite')
	await Promise.all(ids.map((id) => tx.store.delete(id)))
	await tx.done
}
