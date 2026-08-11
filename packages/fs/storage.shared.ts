import type { InodeMeta, MutationOptions, StorageChange } from './storage'
import type { DirentMin, FileType, Ino } from './types'

/** Join a canonical directory path and a child name. */
export function joinPath(dirPath: string, name: string): string {
	return dirPath === '/' ? `/${name}` : `${dirPath}/${name}`
}

/**
 * The raw transaction-scoped tree seam available to a mutation observer.
 * It contains filesystem operations only.
 */
export interface TreePort {
	mintIno(): Ino
	resolveIno(path: string): Promise<Ino | null>
	pathOf(ino: Ino): Promise<string | null>
	enumerateSubtree(ino: Ino): Promise<{ ino: Ino; rel: string }[]>
	ensureDirPath(path: string): Promise<Ino>
	getDirent(dirIno: Ino, name: string): Promise<DirentMin | null>
	readMetaXattrs(ino: Ino): Promise<{ meta: InodeMeta; xattrs: Record<string, Uint8Array> } | null>
	upsertInode(
		ino: Ino,
		meta: InodeMeta,
		contentHash: string | undefined,
		xattrs: Record<string, Uint8Array>
	): Promise<void>
	setDirent(dirIno: Ino, name: string, ino: Ino, type: FileType): Promise<void>
	deleteDirent(dirIno: Ino, name: string): Promise<void>
	deleteInodeIfUnreferenced(ino: Ino): Promise<void>
	dirHasLiveChildren(ino: Ino): Promise<boolean>
	emit(change: StorageChange): void
}

/** One filesystem tree change, announced in the order it was applied. */
export type TreeEffect =
	| { kind: 'link'; dirIno: Ino; name: string; ino: Ino; type: FileType }
	| { kind: 'unlink'; dirIno: Ino; name: string; ino: Ino }
	| {
			kind: 'move'
			fromDirIno: Ino
			fromName: string
			toDirIno: Ino
			toName: string
			ino: Ino
			displaced: Ino | null
	  }
	| { kind: 'meta'; ino: Ino }
	| { kind: 'content'; ino: Ino; contentHash: string }

/** Called inside the mutation transaction, after the tree write. */
export interface MutationObserver {
	record(port: TreePort, effect: TreeEffect, options?: MutationOptions): Promise<void>
}
