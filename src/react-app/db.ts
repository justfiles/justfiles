import { openDB as idbOpenDB, type IDBPDatabase } from 'idb'

export interface PendingEdit {
	memoryId: string
	content: string
	savedAt: number
	title?: string
	path?: string
}

interface GhostoreDB {
	'pending-edits': {
		key: string
		value: PendingEdit
	}
}

let dbPromise: Promise<IDBPDatabase<GhostoreDB>> | null = null

export function openDB(): Promise<IDBPDatabase<GhostoreDB>> {
	if (!dbPromise) {
		dbPromise = idbOpenDB<GhostoreDB>('ghostore-db', 1, {
			upgrade(db) {
				db.createObjectStore('pending-edits', { keyPath: 'memoryId' })
			},
		})
	}
	return dbPromise
}

export async function getPendingEdit(memoryId: string): Promise<PendingEdit | undefined> {
	const db = await openDB()
	return db.get('pending-edits', memoryId)
}

export async function getDraftEdit(): Promise<PendingEdit | undefined> {
	const db = await openDB()
	const all = await db.getAll('pending-edits')
	return all.find((e) => e.memoryId.startsWith('draft:'))
}

export async function setPendingEdit(edit: PendingEdit): Promise<void> {
	const db = await openDB()
	try {
		await db.put('pending-edits', edit)
	} catch (err) {
		if (err instanceof DOMException && err.name === 'QuotaExceededError') {
			console.warn('[ghostore/db] QuotaExceededError — IDB write failed, edit not persisted locally')
		} else {
			throw err
		}
	}
}

export async function deletePendingEdit(memoryId: string): Promise<void> {
	const db = await openDB()
	await db.delete('pending-edits', memoryId)
}

export async function getAllPendingEdits(): Promise<PendingEdit[]> {
	const db = await openDB()
	return db.getAll('pending-edits')
}
