import type {
	FileTree,
	FileTreeBatchOperation,
	FileTreeDirectoryHandle,
	FileTreeItemHandle
} from '@pierre/trees'

export type TreeEntry = {
	ino: string
	name: string
	type: number
}

export function isDirectory(item: FileTreeItemHandle | null): item is FileTreeDirectoryHandle {
	return item?.isDirectory() === true
}

export function expandedDirectories(model: FileTree): Set<string> {
	const count = model.getVisibleCount()
	const rows = count === 0 ? [] : model.getVisibleRows(0, count - 1)
	const expanded = new Set<string>()
	for (const row of rows) {
		if (row.kind !== 'directory') continue
		const paths = row.flattenedSegments?.map((segment) => segment.path) ?? [row.path]
		for (const path of paths) {
			const item = model.getItem(path)
			if (isDirectory(item) && item.isExpanded()) expanded.add(path)
		}
	}
	return expanded
}

export function treePath(parent: string, entry: TreeEntry): string {
	const absolute = parent === '/' ? `/${entry.name}` : `${parent}/${entry.name}`
	const path = absolute.slice(1)
	return entry.type === 1 ? `${path}/` : path
}

export function diffChildren(
	parent: string,
	previous: readonly TreeEntry[],
	next: readonly TreeEntry[]
): FileTreeBatchOperation[] {
	const before = new Map(previous.map((entry) => [treePath(parent, entry), entry]))
	const after = new Map(next.map((entry) => [treePath(parent, entry), entry]))
	const added = new Set([...after.keys()].filter((path) => !before.has(path)))
	const removed = new Set([...before.keys()].filter((path) => !after.has(path)))
	const addedFilesByIno = new Map<string, string>()

	for (const path of added) {
		const entry = after.get(path)
		if (entry?.type === 0) addedFilesByIno.set(entry.ino, path)
	}

	const operations: FileTreeBatchOperation[] = []
	for (const from of removed) {
		const entry = before.get(from)
		const to = entry?.type === 0 ? addedFilesByIno.get(entry.ino) : undefined
		if (!to || before.has(to)) continue
		operations.push({ type: 'move', from, to })
		removed.delete(from)
		added.delete(to)
	}

	for (const path of removed)
		operations.push({ type: 'remove', path, recursive: path.endsWith('/') })
	for (const path of added) operations.push({ type: 'add', path })
	return operations
}
