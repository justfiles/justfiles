import type { Ino, Stat, Off, Dirent, FileType, OpenFlags, Fd } from './types';

/**
 * The consumer-facing filesystem interface.
 *
 * Design principles:
 * - Operates on inodes, not paths. Path resolution is a higher layer.
 * - Directory is just a mapping of name → ino, not a special concept.
 * - No convenience methods. rename = link + unlink. ls = open + readdir.
 * - Fd-based I/O with explicit offsets (pread/pwrite style) to avoid
 *   hidden cursor state and enable safe concurrency.
 * - Batch readdir via cursor for performance (avoids 1 syscall per entry).
 */
export interface FileSystem {

  // --- inode operations ---

  /** Stat an inode directly. */
  stat(ino: Ino): Promise<Stat>;

  /** Update mtime, mode, etc. Only set fields are applied. */
  setattr(ino: Ino, attrs: Partial<Pick<Stat, 'mode' | 'mtimeNs'>>): Promise<void>;

  // --- directory operations ---

  /**
   * Look up a single name within a directory inode.
   * This is the primitive that path resolution calls repeatedly.
   * Returns null if not found (not an error — callers need to
   * distinguish "not found" from "I/O failure").
   */
  lookup(dirIno: Ino, name: string): Promise<Ino | null>;

  /**
   * Read directory entries in batches.
   * cursor=0n starts from the beginning. Returns next cursor
   * position (0n means end). Batch size is up to the implementation.
   *
   * Why cursor-based: avoids loading entire directory into memory,
   * and lets the FS impl use whatever internal ordering it wants.
   */
  readdir(dirIno: Ino, cursor: Off): Promise<{
    entries: Dirent[];
    next: Off;
  }>;

  /**
   * Create a new inode and link it into a directory in one atomic op.
   * Returns the new inode number.
   *
   * Why combined: creating an orphan inode is almost never useful,
   * and splitting create + link invites race conditions.
   *
   * For regular files and directories only. Use symlink() for symlinks.
   */
  mknod(dirIno: Ino, name: string, type: FileType, mode: number): Promise<Ino>;

  /**
   * Create a symbolic link.
   * Separated from mknod because the symlink target is a required argument
   * that has no meaning for any other file type.
   */
  symlink(dirIno: Ino, name: string, target: string, mode?: number): Promise<Ino>;

  /**
   * Add a hard link: make name in dirIno point to an existing inode.
   * The VFS increments nlink on the target inode via setMeta.
   * Directories cannot be hard-linked (would create cycles).
   */
  link(dirIno: Ino, name: string, targetIno: Ino): Promise<void>;

  /**
   * Remove a name from a directory. The VFS decrements nlink on the target
   * inode and calls backend.free() only when nlink reaches 0.
   * The metadata cache makes the nlink check typically free (0 RTTs),
   * so common-case unlink (nlink == 1) stays at 2 backend round trips.
   * For directories: must be empty first.
   */
  unlink(dirIno: Ino, name: string): Promise<void>;

  // --- file I/O ---

  /**
   * Open an inode, returning a file descriptor.
   * The VFS checks its metadata cache before hitting the backend —
   * if stat(ino) was recently called, open() costs 0 backend round trips.
   * The Fd is the unit of I/O and the thing higher layers manage.
   */
  open(ino: Ino, flags: OpenFlags): Promise<Fd>;

  /**
   * Positional read — no hidden cursor, no seek.
   * Returns bytes read (may be less than length). 0 = EOF.
   *
   * Why pread over read+seek: eliminates hidden mutable state,
   * makes concurrent reads from the same Fd safe without locking.
   */
  pread(fd: Fd, buf: Uint8Array, offset: Off): Promise<number>;

  /**
   * Positional write. Returns bytes written.
   */
  pwrite(fd: Fd, buf: Uint8Array, offset: Off): Promise<number>;

  /**
   * Ensure written data is durable. Without this, writes may be buffered.
   */
  fsync(fd: Fd): Promise<void>;

  /**
   * Truncate or extend file to exactly size bytes.
   */
  truncate(fd: Fd, size: Off): Promise<void>;

  /** Release the file descriptor and associated resources. */
  close(fd: Fd): Promise<void>;

  // --- symlinks ---

  /**
   * Move or rename a file or directory.
   * The VFS uses backend.rename?() if available (atomic), otherwise
   * synthesizes it as dirLookup + dirSet + dirUnset (non-atomic).
   * If newName already exists in newDirIno, it is atomically replaced
   * (POSIX rename semantics).
   */
  rename(oldDirIno: Ino, oldName: string, newDirIno: Ino, newName: string): Promise<void>;

  /** Read the target of a symlink inode. */
  readlink(ino: Ino): Promise<string>;

  // --- filesystem-level ---

  /** Get root inode. Typically 1n or 2n. Entry point for all path resolution. */
  root(): Ino;
}
