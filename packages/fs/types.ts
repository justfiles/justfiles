/** Inode identifier — unique within a filesystem */
export type Ino = string

/** Byte-level offset */
export type Off = bigint

/**
 * Opaque directory cursor. Passed back to listDirents to continue
 * iteration. Empty string signals start-of-directory; the backend returns
 * empty string to signal end-of-directory.
 *
 * Kept as string (not Off/bigint) so backends can use whatever continuation
 * state they need: a byte offset stringified, a B-tree key, a DynamoDB
 * pagination token, an IndexedDB lower-bound key — without artificial
 * encoding into bigint.
 */
export type DirCursor = string

/** File type — kept minimal. Numeric values are the wire format; do not reorder. */
export const FileType = {
	Regular: 0,
	Directory: 1,
	Symlink: 2
} as const

export type FileType = (typeof FileType)[keyof typeof FileType]

/** Minimal stat — what the FS actually stores per inode */
export interface Stat {
	ino: Ino
	type: FileType
	size: Off
	mode: number
	mtimeNs: bigint
	ctimeNs: bigint
	/**
	 * Hash of the file's current content (e.g. SHA-256, hex-encoded).
	 * Promoted from backend-private InodeMeta to the public Stat surface
	 * because upper layers need it as a change
	 * signal without reading file content.
	 */
	contentHash?: string
}

/** Directory entry — what you get when reading a directory */
export interface Dirent {
	ino: Ino
	name: string
	type: FileType
}

/**
 * Minimal inode reference returned by directory lookup and removal.
 * Carries just enough information for the VFS to compose further operations
 * (e.g. putDirent in rename needs the type; cache invalidation needs the ino)
 * without an extra getMeta round trip.
 */
export interface DirentMin {
	ino: Ino
	type: FileType
}
