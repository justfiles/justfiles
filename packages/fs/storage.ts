import type { FileType, Ino, Off, DirCursor, DirentMin } from './types';

export interface InodeMeta {
  type: FileType;
  size: Off;
  mode: number;
  /**
   * Hard link count. Entirely owned by the backend — the VFS never reads
   * or writes this field directly. The backend increments it inside dirAdd
   * and dirSet (when adding an entry) and decrements it inside dirUnset
   * (freeing the inode when it hits 0). Exposed in Stat so consumers above
   * the VFS can read it.
   *
   * New inodes start at nlink = 0. The first dirAdd call (from mknod or
   * create?) brings it to 1.
   */
  nlink: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
  /**
   * Hash of the file's current content (e.g. SHA-256, hex-encoded).
   * Set by the backend on every write. Absent for directories and symlinks.
   *
   * The primary consumers are:
   *   - Sync layer: compare hashes to decide what to upload.
   *   - Embedding pipeline: skip re-embedding when hash is unchanged.
   */
  contentHash?: string;
  /** For symlinks: the target path. Stored inline to avoid a separate
   *  data read on every symlink traversal. */
  symlinkTarget?: string;
}

/**
 * Fields the VFS may update via setMeta. nlink is excluded — it is
 * managed entirely inside dirSet / dirUnset and is never written by the VFS.
 */
type InodeMetaUpdate = Partial<Pick<InodeMeta, 'mode' | 'mtimeNs' | 'ctimeNs' | 'symlinkTarget'>>;

/**
 * Minimal backend interface.
 *
 * 11 required methods + 3 optional. A filesystem is fundamentally:
 * "a pool of numbered blobs with metadata, plus a naming layer."
 *
 * Hard link reference counting (nlink) is backend-internal. The VFS
 * never calls free(), linkInc(), or linkDec() — it simply adds and
 * removes directory entries via dirAdd / dirSet / dirUnset, and the
 * backend atomically maintains nlink as a side effect.
 *
 * dirAdd and dirSet are intentionally distinct:
 *   dirAdd  — no-clobber insert (mknod, link). TOCTOU-safe.
 *   dirSet  — unconditional replace (rename overwrite path only).
 */
export interface StorageBackend {

  // ==========================================
  // 1. INODE LIFECYCLE — allocate
  // ==========================================

  /**
   * Allocate a new inode with initial metadata. Returns the assigned ino.
   * nlink is not supplied by the caller — the backend initialises it to 0.
   * The first dirAdd call on this inode (from mknod or create?) brings
   * nlink to 1.
   *
   * Why the backend assigns inos: it knows its own numbering strategy
   * (sequential, random, UUID-mapped, etc.). The VFS does not care.
   */
  alloc(meta: Omit<InodeMeta, 'nlink'>): Promise<Ino>;

  /**
   * Atomically allocate a new inode AND add its directory entry,
   * no-clobber. Optional — if implemented, the VFS uses this for mknod
   * instead of the two-step alloc() + dirAdd(). Backends with
   * conditional/transactional writes (DynamoDB, SQLite, Postgres) should
   * implement this to eliminate the orphaned-inode failure window.
   *
   * Fails (rejects) if name already exists in dirIno — matching the
   * no-clobber semantics of dirAdd().
   * The backend sets nlink = 1 inside this operation.
   */
  create?(dirIno: Ino, name: string, meta: Omit<InodeMeta, 'nlink'>): Promise<Ino>;

  // ==========================================
  // 2. INODE METADATA — the "stat" of a node
  // ==========================================

  /**
   * Read all metadata for an inode.
   * Returns null if ino doesn't exist (not an error — the VFS needs to
   * distinguish "gone" from "I/O failure").
   */
  getMeta(ino: Ino): Promise<InodeMeta | null>;

  /**
   * Partial update of metadata fields. nlink is excluded from the update
   * type — nlink is backend-owned and only modified by dirAdd / dirSet /
   * dirUnset. The VFS calls setMeta for chmod, utimes, and similar attribute
   * changes.
   */
  setMeta(ino: Ino, partial: InodeMetaUpdate): Promise<void>;

  // ==========================================
  // 3. DATA I/O — raw byte storage per inode
  // ==========================================

  /**
   * Read up to `length` bytes starting at `offset`.
   * Returns the bytes read. May be shorter than requested (short read)
   * or empty (offset >= size, i.e. EOF).
   */
  read(ino: Ino, offset: Off, length: number): Promise<Uint8Array>;

  /**
   * Write bytes at offset. Grows the file if offset + data.length > size.
   * Returns bytes written (always data.length unless the medium is full).
   * The backend must update size in its metadata if the file grew.
   */
  write(ino: Ino, offset: Off, data: Uint8Array): Promise<number>;

  /**
   * Resize the data to exactly `size` bytes.
   * If shrinking: discard trailing data.
   * If growing: the new bytes read as zeroes.
   *
   * A required primitive rather than a write()-based emulation: truncating
   * a large file to 0 must be O(1), not O(n). Object-store backends without
   * native truncate implement it as putBlob(ino, emptyOrSlicedData).
   */
  truncate(ino: Ino, size: Off): Promise<void>;

  // ==========================================
  // 4. DIRECTORY ENTRIES — the naming layer
  // ==========================================

  /**
   * Look up a single name in a directory inode.
   * Returns { ino, type } or null. Returns type alongside ino so the VFS
   * can use the result in a subsequent dirSet (e.g. in synthesised rename)
   * without an extra getMeta round trip.
   */
  dirLookup(dirIno: Ino, name: string): Promise<DirentMin | null>;

  /**
   * List entries in batches. An empty-string cursor starts from the
   * beginning; the backend returns empty string to signal end-of-directory.
   * The cursor is opaque — a stringified offset, a DynamoDB token, a B-tree
   * key, whatever the backend needs. DirCursor is typed as string to
   * accommodate all of these without artificial encoding.
   */
  dirList(dirIno: Ino, cursor: DirCursor): Promise<{
    entries: { name: string; ino: Ino; type: FileType }[];
    next: DirCursor;
  }>;

  /**
   * Insert a new directory entry if and only if the name does not already
   * exist. Atomically increments nlink on ino when the entry is added.
   * Returns true if the entry was added, false if the name already existed
   * (nlink is NOT modified in that case).
   *
   * This is the primitive for mknod (after alloc) and hard-link creation
   * (link()). It is explicitly no-clobber: the VFS maps a false return to
   * EEXIST. Using a separate no-clobber primitive (rather than a pre-lookup
   * + dirSet) eliminates the TOCTOU race where two concurrent callers both
   * see "name is free" and both proceed to overwrite each other.
   *
   * Crash safety: a crash after alloc() but before dirAdd() leaves an
   * orphaned inode (nlink = 0, no directory entry). Use create?() to
   * close this window for mknod.
   */
  dirAdd(dirIno: Ino, name: string, ino: Ino, type: FileType): Promise<boolean>;

  /**
   * Unconditionally replace (or insert) a directory entry AND atomically
   * manage nlink on both the incoming and any displaced inode.
   * If an existing entry is displaced, the backend atomically decrements
   * nlink on the displaced inode (freeing it if nlink hits 0) and returns
   * the displaced entry so the VFS can invalidate its cache.
   * Returns null if no entry previously existed at name.
   *
   * This is the primitive for the rename overwrite path — the one operation
   * that legitimately replaces an existing name. It is NOT used for mknod
   * or link(); those use dirAdd() to get no-clobber semantics.
   */
  dirSet(dirIno: Ino, name: string, ino: Ino, type: FileType): Promise<DirentMin | null>;

  /**
   * Remove a directory entry AND atomically decrement nlink on the inode,
   * freeing the inode entirely if nlink reaches 0.
   * Returns the removed entry, or null if name was not present.
   *
   * This is the single operation the VFS uses for unlink(). Because nlink
   * is managed atomically inside this call, the VFS never needs a separate
   * decrement or free step.
   *
   * Note: rename() uses dirSet + dirUnset but with a temporary nlink
   * increment followed by a decrement — net zero, so the inode is never
   * freed prematurely. See rename?() for the atomic alternative.
   */
  dirUnset(dirIno: Ino, name: string): Promise<DirentMin | null>;

  /**
   * Atomically move a name from one directory to another (or rename within
   * the same directory). Optional — if absent, the VFS synthesises rename
   * as dirLookup + dirSet + dirUnset.
   *
   * Why synthesised rename is safe but not ideal:
   *   dirSet(newDir, newName, ino, type)  → nlink temporarily +1
   *   dirUnset(oldDir, oldName)           → nlink back to original
   *   Net nlink change: 0. The inode is never freed prematurely.
   *   Downside: there is a window where both names exist simultaneously.
   *
   * rename?() closes that consistency window. If newName already existed,
   * the backend atomically displaces it (decrement its nlink, free if 0)
   * and returns its ino so the VFS can invalidate the cache entry.
   */
  rename?(oldDir: Ino, oldName: string, newDir: Ino, newName: string): Promise<Ino | null>;

  /**
   * Enumerate every inode in the filesystem in a single paginated scan.
   * Optional — cloud backends (DynamoDB, S3) should implement this to avoid
   * O(directories) round trips during sync tree walks.
   *
   * Entries MUST be returned in parent-before-child order so callers can
   * build an ino→path map incrementally without backtracking.
   *
   * The cursor is opaque, same semantics as DirCursor.
   */
  scan?(cursor: string): Promise<{
    entries: { ino: Ino; dirIno: Ino; name: string; meta: InodeMeta }[]
    next: string
  }>

  /**
   * Replace the entire content of a file atomically.
   * Optional — if absent, the VFS falls back to write().
   *
   * Object stores (S3, R2, GCS) do not support partial writes — every
   * mutation is a full object PUT. putBlob() lets the VFS signal "here is
   * the complete new content" so the backend can issue a single PUT with
   * no prior GET. Backends that support efficient partial writes ignore
   * this method.
   */
  putBlob?(ino: Ino, data: Uint8Array): Promise<void>;
}
