import { openDB as idbOpenDB, type DBSchema, type IDBPDatabase } from 'idb'

export interface PendingEdit {
	memoryId: string
	content: string
	savedAt: number
	title?: string
	path?: string
}

export interface PendingPatch {
	id: string
	documentId: string
	kind: 'content' | 'title' | 'path'
	value: string
	savedAt: number
}

interface GhostoreDB extends DBSchema {
	'pending-edits': {
		key: string
		value: PendingEdit
	}
	'pending-patches': {
		key: string
		value: PendingPatch
		indexes: {
			'by-documentId': string
			'by-savedAt': number
		}
	}
}

let dbPromise: Promise<IDBPDatabase<GhostoreDB>> | null = null

function createPatchId(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
		return crypto.randomUUID()
	}
	return `patch_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

export function openDB(): Promise<IDBPDatabase<GhostoreDB>> {
	if (!dbPromise) {
		dbPromise = idbOpenDB<GhostoreDB>('ghostore-db', 1, {
			upgrade(db) {
				db.createObjectStore('pending-edits', { keyPath: 'memoryId' })
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

export async function getPendingEdit(memoryId: string): Promise<PendingEdit | undefined> {
	const db = await openDB()
	return db.get('pending-edits', memoryId)
}

export async function getDraftEdit(): Promise<PendingEdit | undefined> {
	const db = await openDB()
	const draft = await db.get('pending-edits', 'draft')
	if (draft) return draft
	const all = await db.getAll('pending-edits')
	return all.find((e) => e.memoryId.startsWith('draft'))
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
