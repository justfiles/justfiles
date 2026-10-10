import type { Node } from './node'
import type { Store } from './store'

/**
 * Creation defaults supplied by Volume to Store.create. Mode is replicated verbatim,
 * so no layer applies a umask; change a created entry's mode with chmod.
 */
export const FILE_MODE = 0o644
export const DIR_MODE = 0o755

/**
 * A rooted filesystem with absolute, slash-separated paths and no working directory.
 * Relative symlink targets resolve from the link's parent; absolute targets resolve
 * from this volume's root. Resolve `..` after following links; at root it stays at root.
 * Parent components follow symlinks. Link loops and other failures reject.
 * Mutating returned values does not change storage.
 * Calls do not form transactions, and external writers may race them; only writes
 * through this Volume are observable by watch.
 * Known filesystem failures follow the FsError contract in error.ts.
 */
export interface Volume {
	/** Return the resolved node, following the final symlink. Missing paths reject. */
	stat(path: string): Promise<Node>

	/** Like stat, but return the final symlink itself, including a dangling link. */
	lstat(path: string): Promise<Node>

	/** Read a regular file, following symlinks. Missing paths and other types reject. */
	readFile(path: string): Promise<Uint8Array>

	/**
	 * Create or overwrite a regular file, following symlinks. Parent directories
	 * must exist. Exclusive creation rejects any existing entry, including a dangling
	 * symlink. Creation uses FILE_MODE; an overwrite keeps the existing mode.
	 * Creation and overwrite may expose incomplete bytes and do not flush.
	 */
	writeFile(path: string, data: Uint8Array, opts?: { exclusive?: boolean }): Promise<void>

	/** Create one directory with DIR_MODE. Missing parents and any existing entry reject. */
	mkdir(path: string): Promise<void>

	/** Follow the directory path; list immediate children unordered, keeping their symlinks. */
	readdir(path: string): Promise<Node[]>

	/**
	 * Remove a file, symlink, or empty directory without following the final symlink.
	 * With recursive, remove a directory and everything beneath it; symlinks inside are
	 * removed as entries, never followed, and a failure midway stops and leaves the rest.
	 * Missing paths, nonempty directories without recursive, and the volume root reject.
	 */
	rm(path: string, opts?: { recursive?: boolean }): Promise<void>

	/**
	 * Rename atomically without following either final symlink. A non-directory may
	 * replace a non-directory; a directory may replace an empty directory. Incompatible
	 * types, root moves, directory cycles, and moves across stores reject.
	 */
	rename(oldPath: string, newPath: string): Promise<void>

	/**
	 * Create a symlink with its target stored verbatim; the target need not exist.
	 * Missing parents and any existing entry reject.
	 */
	symlink(target: string, path: string): Promise<void>

	/** Read the final symlink's target verbatim. Missing paths and other types reject. */
	readlink(path: string): Promise<string>

	/**
	 * Set a file or directory's rwx bits, following symlinks.
	 * mode must be an integer from 0 to 0o777. Missing paths and invalid or unsupported
	 * modes reject. Does not flush.
	 */
	chmod(path: string, mode: number): Promise<void>

	/**
	 * Set a file or directory's modification time, following symlinks.
	 * mtimeNs is nanoseconds since the Unix epoch; backend precision may round it.
	 * Missing paths or unsupported timestamps reject. Does not flush.
	 */
	utimes(path: string, mtimeNs: bigint): Promise<void>

	/**
	 * Persist a file or directory through Store.flush, following symlinks. Flush parent
	 * directories to persist entry creation, removal, or renaming. Does not recurse.
	 * Durability is limited to the backing storage's lifetime.
	 */
	flush(path: string): Promise<void>

	/**
	 * Observe the entry at path: its content, metadata, creation, removal, and any rename
	 * or rebinding of the path or an ancestor. For a directory, also observe its immediate
	 * entries; with recursive, everything beneath it. The path need not exist yet.
	 * A delivery is a wake, not a log: it carries no per-change detail, a burst coalesces
	 * into bounded deliveries with a guaranteed trailing one, and a listener may be woken
	 * after it already read the new state. Wrappers and proxies forward watch.
	 * Returns the unsubscribe.
	 */
	watch(
		path: string,
		listener: (event: WatchEvent) => void,
		opts?: { recursive?: boolean }
	): () => void
}

/** local: a write through this Volume. remote: an installed authority change (sync.engine.ts). */
export type WatchEvent = { source: 'local' | 'remote' }

export function volume(store: Store): Volume {
	throw new Error('TODO: not implemented')
}
