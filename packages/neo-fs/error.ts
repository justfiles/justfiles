/**
 * Known Store and Volume failures, using POSIX / Node.js filesystem error codes.
 * https://nodejs.org/api/errors.html#common-system-errors
 */
export type FsErrorCode =
	/** A requested node or path component is missing. */
	| 'ENOENT'
	/** A name is occupied where creation requires a free name. */
	| 'EEXIST'
	/** A parent or directory argument refers to a non-directory. */
	| 'ENOTDIR'
	/** A file operation or non-directory replacement targets a directory. */
	| 'EISDIR'
	/** Removal or replacement requires an empty directory. */
	| 'ENOTEMPTY'
	/** Symlink resolution encounters a loop or exceeds its depth limit. */
	| 'ELOOP'
	/** Invalid argument, readlink on a non-link, or moving a directory into its descendant. */
	| 'EINVAL'
	/** A rename crosses store or filesystem boundaries. */
	| 'EXDEV'
	/** Filesystem permissions deny access. */
	| 'EACCES'
	/** The operation itself is forbidden, even if the path is accessible. */
	| 'EPERM'
	/** A mutation targets read-only storage. */
	| 'EROFS'
	/** An entry is in use; also used when removing or moving the volume root. */
	| 'EBUSY'
	/** Storage has no room for more data or entries. */
	| 'ENOSPC'
	/** A storage quota has been reached. */
	| 'EDQUOT'
	/** A file exceeds the backend's supported size. */
	| 'EFBIG'
	/** A name or path exceeds the backend's length limit. */
	| 'ENAMETOOLONG'
	/** The process cannot open more file handles. */
	| 'EMFILE'
	/** The system cannot open more file handles. */
	| 'ENFILE'
	/** Storage failed to read, write, or persist data. */
	| 'EIO'
	/** The filesystem does not support the requested operation. */
	| 'ENOTSUP'
	/** The platform does not provide the required system call. */
	| 'ENOSYS'

/**
 * Check code, not message or numeric errno. Native errors with these codes already
 * fit this shape; other backends map equivalent failures to the same codes and
 * preserve the original error as cause when wrapping. Unknown errors propagate
 * unchanged; they must not be guessed from messages or treated as missing entries.
 */
export interface FsError extends Error {
	readonly code: FsErrorCode
	/** The affected path, when available. Store errors may have no path. */
	readonly path?: string
	/** The destination path of a failed rename, when available. */
	readonly dest?: string
}
