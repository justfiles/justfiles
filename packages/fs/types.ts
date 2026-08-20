/** Inode identifier — unique within a filesystem */
export type Ino = string

/** Byte-level offset */
export type Off = bigint

/** File type — kept minimal. Numeric values are the wire format; do not reorder. */
export const FileType = {
	Regular: 0,
	Directory: 1,
	Symlink: 2
} as const

export type FileType = (typeof FileType)[keyof typeof FileType]

/** Minimal stat — what a path resolves to. The row IS this, less the plumbing. */
export interface Stat {
	ino: Ino
	type: FileType
	size: Off
	mode: number
	mtimeNs: bigint
	ctimeNs: bigint
	/**
	 * Hash of the file's current content (SHA-256, hex-encoded) — the row's
	 * `content`, verbatim. On the stat because upper layers need a change signal
	 * without reading the file.
	 */
	contentHash?: string
}

/** Directory entry — what you get when reading a directory */
export interface Dirent {
	ino: Ino
	name: string
	type: FileType
}
