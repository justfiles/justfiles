import type { FileMeta } from './types'

export interface MemoryIndex {
	hydrate(entries: FileMeta[]): void
	upsert(entry: FileMeta): void
	remove(id: string): void
	get(id: string): FileMeta | null
	getByPath(path: string): FileMeta | null
	getPath(id: string): string | null
	getId(path: string): string | null
}

export function createMemoryIndex(): MemoryIndex {
	const byId = new Map<string, FileMeta>()
	const idByPath = new Map<string, string>()

	function indexEntry(entry: FileMeta): void {
		const previous = byId.get(entry.id)
		if (previous) idByPath.delete(previous.path)
		byId.set(entry.id, entry)
		idByPath.set(entry.path, entry.id)
	}

	return {
		hydrate(entries) {
			byId.clear()
			idByPath.clear()
			for (const entry of entries) indexEntry(entry)
		},

		upsert(entry) {
			indexEntry(entry)
		},

		remove(id) {
			const existing = byId.get(id)
			if (!existing) return
			byId.delete(id)
			idByPath.delete(existing.path)
		},

		get(id) {
			return byId.get(id) ?? null
		},

		getByPath(path) {
			const id = idByPath.get(path)
			return id ? byId.get(id) ?? null : null
		},

		getPath(id) {
			return byId.get(id)?.path ?? null
		},

		getId(path) {
			return idByPath.get(path) ?? null
		},
	}
}
