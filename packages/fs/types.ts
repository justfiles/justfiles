/** Opaque handle — like a file descriptor */
export type Fd = number;

/** Inode identifier — unique within a filesystem */
export type Ino = bigint;

/** Byte-level offset */
export type Off = bigint;

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
  mtimeNs: bigint;
  ctimeNs: bigint;
}

/** Directory entry — what you get when reading a directory */
export interface Dirent {
  ino: Ino;
  name: string;
  type: FileType;
}

/** Flags for open() — composable via bitwise OR */
export const enum OpenFlags {
  Read   = 1 << 0,
  Write  = 1 << 1,
  Create = 1 << 2,
  Trunc  = 1 << 3,
  Append = 1 << 4,
  Excl   = 1 << 5, // fail if exists (with Create)
}
