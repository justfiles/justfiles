import type { FileType, Ino, Off } from './types';

interface InodeMeta {
  type: FileType;
  size: Off;
  mode: number;
  /**
   * Hard link count. Managed entirely by the VFS — the backend stores this
   * number but has no logic around it. The VFS increments on link(), decrements
   * on unlink(), and calls free() only when it reaches 0.
   * Always 1 for newly allocated inodes. Directories are always 1 (no hard links
   * to directories — they create cycles).
   */
  nlink: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
  /**
   * Hash of the file's current content (e.g. SHA-256, hex-encoded).
   * Set by the backend on every write. Absent for directories and symlinks.
   *
   * The primary consumers are:
   *   - Sync layer: compare hashes to decide what to upload, without reading content.
   *   - Embedding pipeline: if hash unchanged since last embedding, skip re-embedding.
   */
  contentHash?: string;
  /** For symlinks: the target path. Stored inline in metadata
   *  because symlink targets are small and always read atomically.
   *  This avoids a separate data read for every symlink traversal. */
  symlinkTarget?: string;
}

/**
 * Minimal backend interface.
 *
 * 10 methods. That's it. A filesystem is fundamentally:
 * "a pool of numbered blobs with metadata, plus a naming layer."
 */
export interface StorageBackend {

  // ==========================================
  // 1. INODE LIFECYCLE — allocate and free
  // ==========================================

  /**
   * Allocate a new inode with initial metadata.
   * Returns the assigned ino.
   *
   * Why the backend assigns inos: it knows its own numbering
   * strategy (sequential, random, reuse-from-freelist, UUIDs
   * mapped to bigint — whatever). The VFS doesn't care.
   */
  alloc(meta: InodeMeta): Promise<Ino>;

  /**
   * Atomically allocate a new inode AND add its directory entry.
   * Optional — if implemented, the VFS uses this for mknod instead
   * of the two-step alloc() + dirSet(). Backends that support
   * atomic conditional writes (DynamoDB, SQLite transactions) should
   * implement this to eliminate the orphaned-inode failure window.
   */
  create?(dirIno: Ino, name: string, meta: InodeMeta): Promise<Ino>;

  /**
   * Permanently destroy an inode and its data.
   * The VFS calls this when nlink hits 0 and no Fds are open.
   * The backend reclaims all storage.
   */
  free(ino: Ino): Promise<void>;

  // ==========================================
  // 2. INODE METADATA — the "stat" of a node
  // ==========================================

  /**
   * Read all metadata for an inode.
   * Returns null if ino doesn't exist (not an error — the VFS
   * needs to distinguish "gone" from "I/O failure").
   */
  getMeta(ino: Ino): Promise<InodeMeta | null>;

  /**
   * Partial update of metadata fields.
   * The VFS calls this for chmod, utimes, and to bump nlink
   * on link/unlink. Size is updated implicitly by write/truncate,
   * but the VFS may also call setMeta to update size after truncate.
   */
  setMeta(ino: Ino, partial: Partial<InodeMeta>): Promise<void>;

  // ==========================================
  // 3. DATA I/O — raw byte storage per inode
  // ==========================================

  /**
   * Read up to `length` bytes starting at `offset`.
   * Returns the bytes read. May be shorter than requested (short read)
   * or empty (offset >= size, i.e. EOF).
   *
   * Why this is on the backend: the storage medium knows how its
   * data is chunked (4K blocks, S3 range requests, DB blobs).
   * The VFS just sees a byte stream.
   */
  read(ino: Ino, offset: Off, length: number): Promise<Uint8Array>;

  /**
   * Write bytes at offset. Grows the file if offset + data.length > size.
   * Returns bytes written (always data.length unless the medium is full).
   *
   * The backend must update size in its metadata if the file grew.
   * This is the ONE place where the backend implicitly mutates metadata
   * as a side effect — keeping size consistent with actual data is a
   * storage-level invariant, not a VFS concern.
   */
  write(ino: Ino, offset: Off, data: Uint8Array): Promise<number>;

  /**
	 * TODO: evaluate the necessity for our purpose
   * Resize the data to exactly `size` bytes.
   * If shrinking: discard trailing data.
   * If growing: the new bytes read as zeroes.
   *
   * Could this be built from write()? Technically yes — but
   * it's a separate primitive because the implementation is
   * fundamentally different. Truncating a 10GB file to 0 should
   * be O(1) (drop all blocks), not O(n) (write zeroes). Every
   * real filesystem treats it as a distinct operation.
   */
  // truncate(ino: Ino, size: Off): Promise<void>;

  // ==========================================
  // 4. DIRECTORY ENTRIES — the naming layer
  // ==========================================

  /**
   * Look up a single name in a directory inode.
   * Returns the ino it points to, or null.
   *
   * Why this is a backend primitive and not "just read the
   * directory data and parse it": the backend chooses the
   * directory format (linear list, hash table, B-tree).
   * A good implementation makes this O(1) or O(log n).
   * If the VFS had to read raw bytes and scan, it'd be O(n)
   * and the VFS would need to know the on-disk format.
   */
  dirLookup(dirIno: Ino, name: string): Promise<Ino | null>;

  /**
   * List entries in batches. cursor=0n starts from beginning.
   * Returns entries and a next cursor (0n = done).
   *
   * The cursor is opaque to the VFS — it could be a byte offset,
   * a B-tree key, a DynamoDB pagination token, whatever.
   */
  dirList(dirIno: Ino, cursor: Off): Promise<{
    entries: { name: string; ino: Ino; type: FileType }[];
    next: Off;
  }>;

  /**
   * Add or overwrite an entry in a directory.
   * This is the atomic "name → ino" binding.
   *
   * The VFS calls this for: mknod (after alloc), link, rename.
   * The backend doesn't validate anything — it just stores the mapping.
   * Validation (target exists, no duplicate names, etc.) is VFS work.
   */
  dirSet(dirIno: Ino, name: string, ino: Ino, type: FileType): Promise<void>;

  /**
   * Remove an entry from a directory. Returns the ino that was removed,
   * or null if the name didn't exist.
   *
   * Returning the ino saves the VFS a separate dirLookup() call before
   * removal — critical when every call is a potential network round trip.
   * The VFS uses the returned ino to call free() after removal.
   */
  dirUnset(dirIno: Ino, name: string): Promise<Ino | null>;

  /**
   * Atomically move a name from one directory to another (or rename
   * within the same directory). Optional — if absent, the VFS synthesizes
   * rename as dirSet + dirUnset, which is not atomic.
   *
   * Backends that support atomic rename (POSIX, SQLite, DynamoDB
   * transactions) should implement this to avoid a failure window
   * where the new name exists but the old name hasn't been removed yet.
   *
   * The backend overwrites newName in newDir if it already exists,
   * matching POSIX rename(2) semantics. The displaced inode (if any)
   * is returned so the VFS can call free() if needed.
   */
  rename?(oldDir: Ino, oldName: string, newDir: Ino, newName: string): Promise<Ino | null>;

  /**
   * Replace the entire content of a file atomically.
   * Optional — if absent, the VFS falls back to write().
   *
   * Object stores (S3, R2, GCS) don't support partial writes — every
   * mutation is a full object put. For those backends, write() would
   * require a read-modify-write cycle for every partial update, which
   * is expensive. putBlob() lets the VFS signal "I have the full
   * content" so the backend can issue a single PUT without a prior GET.
   *
   * The VFS uses this when writing an entire file from offset 0
   * (e.g., the result of a full document edit).
   */
  putBlob?(ino: Ino, data: Uint8Array): Promise<void>;
}
