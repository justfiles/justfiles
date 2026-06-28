import type { Volume } from '@justfiles/fs'
import type { IFileSystem } from 'just-bash'

/**
 * Adapt a @justfiles/fs Volume to just-bash's IFileSystem, so a Bash instance
 * reads and writes the SAME volume the rest of the system shares — no copy, no
 * mirror, no sync. This is the only seam between the two worlds; everything else
 * just-bash does (parsing, ~70 commands, pipes, globs) runs unchanged on top.
 *
 * It is a pure translation layer — just-bash is text / Date / partly-synchronous,
 * Volume is bytes / bigint / fully-async:
 *   - encode/decode bytes ↔ string per the requested BufferEncoding
 *   - Stat.type (FileType enum) ↔ { isFile, isDirectory, isSymbolicLink }
 *   - mtimeNs (bigint) ↔ Date
 *
 * Two IFileSystem methods have no clean Volume counterpart and are the only real
 * gaps to decide at implementation time:
 *   - getAllPaths() is SYNCHRONOUS (it drives glob `*` expansion) but Volume.scan
 *     is async — so glob runs off a lazily-refreshed path snapshot, or returns []
 *     (no expansion) until one exists.
 *   - link() (hard links) — Volume has no hard links; throw ENOSYS.
 */
export function volumeFs(vol: Volume): IFileSystem {
	void vol
	throw new Error('volumeFs: not implemented')
}
