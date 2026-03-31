/** Opaque handle — like a file descriptor */
export type Fd = number;

/** Inode identifier — unique within a filesystem */
export type Ino = string;

/** Byte-level offset */
export type Off = bigint;

/**
 * Opaque directory cursor. Passed back to dirList / readdir to continue
 * iteration. Empty string signals start-of-directory; the backend returns
 * empty string to signal end-of-directory.
 *
 * Kept as string (not Off/bigint) so backends can use whatever continuation
 * state they need: a byte offset stringified, a B-tree key, a DynamoDB
 * pagination token, an IndexedDB lower-bound key — without artificial
 * encoding into bigint.
 */
export type DirCursor = string;

/** File type — kept minimal */
export const enum FileType {
  Regular,
  Directory,
  Symlink,
}

/** Minimal stat — what the FS actually stores per inode */
export interface Stat {
  ino: Ino;
  type: FileType;
  size: Off;
  mode: number;
  /**
   * Hard link count. Maintained entirely inside the backend as a side
   * effect of dirAdd / dirSet / dirUnset — the VFS never reads or writes
   * this field directly. Exposed here so consumers above the VFS can read
   * it without knowing about InodeMeta.
   */
  nlink: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
  /**
   * Hash of the file's current content (e.g. SHA-256, hex-encoded).
   * Promoted from backend-private InodeMeta to the public Stat surface
   * because upper layers (sync, embedding pipeline) need it as a change
   * signal without reading file content.
   */
  contentHash?: string;
}

/** Directory entry — what you get when reading a directory */
export interface Dirent {
  ino: Ino;
  name: string;
  type: FileType;
}

/**
 * Minimal inode reference returned by directory lookup and removal.
 * Carries just enough information for the VFS to compose further operations
 * (e.g. dirSet in rename needs the type; cache invalidation needs the ino)
 * without an extra getMeta round trip.
 */
export interface DirentMin {
  ino: Ino;
  type: FileType;
}

/**
 * Flags for open() — access mode and optional truncate-on-open.
 *
 * Intentionally minimal: open() is inode-based, so creation and existence
 * checks (Create, Excl) are path-layer concerns handled by mknod/lookup.
 * Append is omitted because it requires hidden fd state that conflicts with
 * the stateless positional pread/pwrite design.
 */
export const enum OpenFlags {
  Read  = 1 << 0,
  Write = 1 << 1,
  /** Truncate file to 0 bytes on open. Only meaningful with Write. */
  Trunc = 1 << 2,
}
