import type { FileSystem } from './fs'
import { FileType, OpenFlags } from './types'
import type { Dirent, Stat } from './types'
import type { Ino } from './types'

/**
 * Path-based filesystem interface built on top of FileSystem.
 *
 * Design principles:
 * - All paths are absolute (start with '/').
 * - No encoding at this layer — I/O is always Uint8Array. The caller decodes.
 * - No hidden cursor state — readdir returns the full list, scan streams via
 *   a visitor.
 * - Symlinks are followed by default (stat, readFile, etc). Use lstat to
 *   inspect a symlink itself.
 * - Errors follow POSIX naming (ENOENT, EEXIST, ENOTDIR, EISDIR, ENOTEMPTY)
 *   thrown as plain Error objects with the code at the start of the message.
 */
export interface Volume {

	// --- metadata ---

	/**
	 * Stat a path, following symlinks.
	 * Throws ENOENT if the path does not exist.
	 */
	stat(path: string): Promise<Stat>

	/**
	 * Stat a path without following the final symlink component.
	 * Useful for inspecting symlinks themselves.
	 */
	lstat(path: string): Promise<Stat>

	/** Returns true if the path exists (any file type). Never throws. */
	exists(path: string): Promise<boolean>

	/** Read a single xattr from a path, following the final symlink. */
	getXattr(path: string, name: string): Promise<Uint8Array | null>

	/** Write or replace a single xattr on a path, following the final symlink. */
	setXattr(path: string, name: string, value: Uint8Array): Promise<void>

	/** List all xattr names currently set on a path. */
	listXattr(path: string): Promise<string[]>

	/** Remove a single xattr from a path. */
	removeXattr(path: string, name: string): Promise<void>

	// --- file I/O ---

	/**
	 * Read the entire contents of a file into memory.
	 * Throws ENOENT if the file does not exist.
	 * Throws EISDIR if the path is a directory.
	 */
	readFile(path: string): Promise<Uint8Array>

	/**
	 * Write (create or overwrite) a file atomically.
	 * Parent directory must exist.
	 * Throws ENOENT if a parent directory is missing.
	 * Throws EISDIR if the path refers to a directory.
	 */
	writeFile(path: string, data: Uint8Array): Promise<void>

	/**
	 * Append data to a file, creating it if it does not exist.
	 * Parent directory must exist.
	 */
	appendFile(path: string, data: Uint8Array): Promise<void>

	// --- directory operations ---

	/**
	 * Create a directory.
	 * With recursive: silently succeeds if the directory already exists and
	 * creates all missing parent directories.
	 * Without recursive (default): throws EEXIST if the path exists, throws
	 * ENOENT if a parent is missing.
	 */
	mkdir(path: string, opts?: { recursive?: boolean; mode?: number }): Promise<void>

	/**
	 * List the contents of a directory.
	 * Returns one Dirent per entry (name + type + ino).
	 * Throws ENOENT if the directory does not exist.
	 * Throws ENOTDIR if the path is not a directory.
	 */
	readdir(path: string): Promise<Dirent[]>

	// --- removal ---

	/**
	 * Remove a file, symlink, or directory.
	 * - recursive: remove non-empty directories (like rm -r).
	 * - force: silently succeed if the path does not exist (like rm -f).
	 * Throws ENOTEMPTY if the path is a non-empty directory and recursive is
	 * not set.
	 */
	rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>

	// --- move and copy ---

	/**
	 * Move or rename a file, symlink, or directory.
	 * If newPath already exists it is replaced atomically (POSIX rename
	 * semantics). Throws ENOENT if oldPath does not exist.
	 */
	rename(oldPath: string, newPath: string): Promise<void>

	/**
	 * Copy a file or directory.
	 * - recursive: required when src is a directory; copies the entire subtree.
	 * If dest already exists it is overwritten for files; for directories the
	 * contents are merged.
	 * Throws EISDIR / ENOTDIR on type mismatches.
	 */
	cp(src: string, dest: string, opts?: { recursive?: boolean }): Promise<void>

	// --- symlinks ---

	/**
	 * Create a symbolic link at path pointing to target.
	 * Argument order mirrors POSIX ln -s: symlink(target, path).
	 * Throws EEXIST if path already exists.
	 */
	symlink(target: string, path: string): Promise<void>

	/**
	 * Read the raw target string of a symbolic link.
	 * Throws ENOENT if path does not exist.
	 * Throws EINVAL if path is not a symlink.
	 */
	readlink(path: string): Promise<string>

	// --- permissions and timestamps ---

	/**
	 * Change the permission mode bits of a file or directory.
	 * Follows symlinks (acts on the target, not the link itself).
	 */
	chmod(path: string, mode: number): Promise<void>

	/**
	 * Set the modification time of a file or directory.
	 * Expressed in nanoseconds since the Unix epoch.
	 * Useful for preserving mtimes when syncing or copying.
	 */
	utimes(path: string, mtimeNs: bigint): Promise<void>

	// --- tree walking ---

	/**
	 * Walk the subtree rooted at path, calling visitor once per node
	 * (including the root itself).
	 *
	 * Directories are visited before their contents. Paths passed to the
	 * visitor are absolute and normalised.
	 *
	 * Delegates to FileSystem.scan() when the storage backend supports it —
	 * O(pages) round trips for cloud backends. Falls back to recursive readdir.
	 *
	 * Throws ENOENT if path does not exist.
	 */
	scan(
		path: string,
		visitor: (path: string, stat: Stat) => Promise<void>,
	): Promise<void>
}

export function volume(fs: FileSystem): Volume {
	const MAX_SYMLINK_DEPTH = 40

	/**
	 * Resolve an absolute path to an inode number.
	 * followLast controls whether a final symlink component is followed.
	 *
	 * Uses a mutable queue + inoStack so that:
	 *  - '..' pops the stack without re-walking from root
	 *  - symlink targets (relative or absolute) are spliced into the queue
	 *    in-place, keeping the loop linear and handling chains naturally
	 */
	async function resolvePath(path: string, followLast: boolean, initialDepth = 0): Promise<Ino> {
		const normalized = path.replace(/\/+$/, '') || '/'
		if (normalized === '/') return fs.root()

		// Mutable queue of remaining components
		const queue: string[] = normalized.split('/').filter(p => p !== '')
		// Stack of resolved inodes; inoStack[0] is always root
		const inoStack: Ino[] = [fs.root()]
		let symlinkDepth = initialDepth

		for (let i = 0; i < queue.length; i++) {
			const name = queue[i]!

			if (name === '.') continue

			if (name === '..') {
				if (inoStack.length > 1) inoStack.pop()
				continue
			}

			const isLast = i === queue.length - 1
			const currentIno = inoStack[inoStack.length - 1]!

			const childIno = await fs.lookup(currentIno, name)
			if (childIno === null) throw new Error(`ENOENT: ${path}`)

			const stat = await fs.stat(childIno)

			if (stat.type === FileType.Symlink && (!isLast || followLast)) {
				if (++symlinkDepth > MAX_SYMLINK_DEPTH) throw new Error('ELOOP: too many levels of symbolic links')

				const target = await fs.readlink(childIno)
				const targetParts = target.split('/').filter(p => p !== '')

				if (target.startsWith('/')) {
					// Absolute target: reset traversal to root
					inoStack.splice(0, inoStack.length, fs.root())
				}
				// Replace the current component with the target components
				queue.splice(i, 1, ...targetParts)
				i-- // re-process from the first target part (loop will i++)
			} else {
				inoStack.push(childIno)
			}
		}

		return inoStack[inoStack.length - 1]!
	}

	/** Split path into parent dir path and final name component. */
	function splitPath(path: string): { dir: string; name: string } {
		const lastSlash = path.lastIndexOf('/')
		const dir = lastSlash === 0 ? '/' : path.slice(0, lastSlash)
		const name = path.slice(lastSlash + 1)
		return { dir, name }
	}

	/** Resolve the parent directory of a path, returning its ino and the final name. */
	async function resolveParent(path: string): Promise<{ dirIno: Ino; name: string }> {
		const { dir, name } = splitPath(path)
		const dirIno = await resolvePath(dir, true)
		return { dirIno, name }
	}

	/** Read all entries from a directory, handling pagination. */
	async function readdirAll(dirIno: Ino): Promise<Dirent[]> {
		const entries: Dirent[] = []
		let cursor = ''
		do {
			const batch = await fs.readdir(dirIno, cursor)
			entries.push(...batch.entries)
			cursor = batch.next
		} while (cursor !== '')
		return entries
	}

	return {
		async stat(path) {
			const ino = await resolvePath(path, true)
			return fs.stat(ino)
		},

		async lstat(path) {
			const ino = await resolvePath(path, false)
			return fs.stat(ino)
		},

		async exists(path) {
			try {
				await resolvePath(path, false)
				return true
			} catch {
				return false
			}
		},

		async getXattr(path, name) {
			const ino = await resolvePath(path, true)
			return fs.getXattr(ino, name)
		},

		async setXattr(path, name, value) {
			const ino = await resolvePath(path, true)
			await fs.setXattr(ino, name, value)
		},

		async listXattr(path) {
			const ino = await resolvePath(path, true)
			return fs.listXattr(ino)
		},

		async removeXattr(path, name) {
			const ino = await resolvePath(path, true)
			await fs.removeXattr(ino, name)
		},

		async readFile(path) {
			const ino = await resolvePath(path, true)
			const stat = await fs.stat(ino)
			if (stat.type === FileType.Directory) {
				throw new Error(`EISDIR: ${path}`)
			}
			const fd = await fs.open(ino, OpenFlags.Read)
			try {
				const buf = new Uint8Array(Number(stat.size))
				let offset = 0n
				while (offset < stat.size) {
					const n = await fs.pread(fd, buf.subarray(Number(offset)), offset)
					if (n === 0) break
					offset += BigInt(n)
				}
				return buf
			} finally {
				await fs.close(fd)
			}
		},

		async writeFile(path, data) {
			// Follow the full path (including any final symlink) so writes go to
			// the symlink target, not to the symlink inode itself.
			let ino: Ino
			let resolved: Ino | null = null
			try {
				resolved = await resolvePath(path, true)
			} catch (e) {
				if (!(e as Error).message.startsWith('ENOENT')) throw e
			}

			if (resolved !== null) {
				const stat = await fs.stat(resolved)
				if (stat.type === FileType.Directory) throw new Error(`EISDIR: ${path}`)
				ino = resolved
			} else {
				const { dirIno, name } = await resolveParent(path)
				ino = await fs.mknod(dirIno, name, FileType.Regular, 0o644)
			}

			const fd = await fs.open(ino, OpenFlags.Write | OpenFlags.Trunc)
			try {
				await fs.pwrite(fd, data, 0n)
				await fs.fsync(fd)
			} finally {
				await fs.close(fd)
			}
		},

		async appendFile(path, data) {
			let ino: Ino
			let appendOffset: bigint
			let resolved: Ino | null = null
			try {
				resolved = await resolvePath(path, true)
			} catch (e) {
				if (!(e as Error).message.startsWith('ENOENT')) throw e
			}

			if (resolved !== null) {
				const stat = await fs.stat(resolved)
				if (stat.type === FileType.Directory) throw new Error(`EISDIR: ${path}`)
				ino = resolved
				appendOffset = stat.size
			} else {
				const { dirIno, name } = await resolveParent(path)
				ino = await fs.mknod(dirIno, name, FileType.Regular, 0o644)
				appendOffset = 0n
			}

			const fd = await fs.open(ino, OpenFlags.Write)
			try {
				await fs.pwrite(fd, data, appendOffset)
				await fs.fsync(fd)
			} finally {
				await fs.close(fd)
			}
		},

		async mkdir(path, opts) {
			const recursive = opts?.recursive ?? false
			const mode = opts?.mode ?? 0o755

			if (recursive) {
				const parts = path.split('/').filter(p => p !== '')
				let current = '/'
				for (const part of parts) {
					const parentPath = current
					current = current === '/' ? `/${part}` : `${current}/${part}`
					const parentIno = await resolvePath(parentPath, true)
					const existingIno = await fs.lookup(parentIno, part)
					if (existingIno !== null) continue
					try {
						await fs.mknod(parentIno, part, FileType.Directory, mode)
					} catch (e) {
						// Concurrent mkdir — another caller created the directory between our
						// lookup and mknod. That's fine; swallow EEXIST and move on.
						if (!(e instanceof Error) || !e.message.startsWith('EEXIST')) throw e
					}
				}
				return
			}

			const { dirIno, name } = await resolveParent(path)
			const existingIno = await fs.lookup(dirIno, name)
			if (existingIno !== null) {
				throw new Error(`EEXIST: ${path}`)
			}
			await fs.mknod(dirIno, name, FileType.Directory, mode)
		},

		async readdir(path) {
			const ino = await resolvePath(path, true)
			const stat = await fs.stat(ino)
			if (stat.type !== FileType.Directory) {
				throw new Error(`ENOTDIR: ${path}`)
			}
			return readdirAll(ino)
		},

		async rm(path, opts) {
			const force = opts?.force ?? false
			const recursive = opts?.recursive ?? false

			let ino: Ino
			try {
				ino = await resolvePath(path, false)
			} catch (e) {
				if (force && (e as Error).message.startsWith('ENOENT')) return
				throw e
			}

			const stat = await fs.stat(ino)
			if (stat.type === FileType.Directory) {
				const entries = await readdirAll(ino)
				if (entries.length > 0 && !recursive) {
					throw new Error(`ENOTEMPTY: ${path}`)
				}
				if (recursive) {
					for (const entry of entries) {
						const childPath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`
						await this.rm(childPath, { recursive: true })
					}
				}
			}

			const { dirIno, name } = await resolveParent(path)
			await fs.unlink(dirIno, name)
		},

		async rename(oldPath, newPath) {
			const { dirIno: oldDirIno, name: oldName } = await resolveParent(oldPath)
			const { dirIno: newDirIno, name: newName } = await resolveParent(newPath)
			await fs.rename(oldDirIno, oldName, newDirIno, newName)
		},

		async cp(src, dest, opts) {
			const recursive = opts?.recursive ?? false

			const srcIno = await resolvePath(src, true)
			const srcStat = await fs.stat(srcIno)

			if (srcStat.type === FileType.Directory) {
				if (!recursive) {
					throw new Error(`EISDIR: ${src}`)
				}

				let destExists = false
				try {
					const destIno = await resolvePath(dest, true)
					const destStat = await fs.stat(destIno)
					if (destStat.type !== FileType.Directory) {
						throw new Error(`ENOTDIR: ${dest}`)
					}
					destExists = true
				} catch (e) {
					if (!(e as Error).message.startsWith('ENOENT')) throw e
				}

				if (!destExists) {
					await this.mkdir(dest, { mode: srcStat.mode })
				}

				const entries = await readdirAll(srcIno)
				for (const entry of entries) {
					const srcChild = src === '/' ? `/${entry.name}` : `${src}/${entry.name}`
					const destChild = dest === '/' ? `/${entry.name}` : `${dest}/${entry.name}`
					await this.cp(srcChild, destChild, { recursive })
				}
			} else {
				try {
					const destIno = await resolvePath(dest, true)
					const destStat = await fs.stat(destIno)
					if (destStat.type === FileType.Directory) {
						throw new Error(`EISDIR: ${dest}`)
					}
				} catch (e) {
					if (!(e as Error).message.startsWith('ENOENT')) throw e
				}

				const data = await this.readFile(src)
				await this.writeFile(dest, data)
			}
		},

		async symlink(target, path) {
			const { dirIno, name } = await resolveParent(path)
			const existingIno = await fs.lookup(dirIno, name)
			if (existingIno !== null) {
				throw new Error(`EEXIST: ${path}`)
			}
			await fs.symlink(dirIno, name, target)
		},

		async readlink(path) {
			const ino = await resolvePath(path, false)
			const stat = await fs.stat(ino)
			if (stat.type !== FileType.Symlink) {
				throw new Error(`EINVAL: ${path} is not a symlink`)
			}
			return fs.readlink(ino)
		},

		async chmod(path, mode) {
			const ino = await resolvePath(path, true)
			await fs.setattr(ino, { mode })
		},

		async utimes(path, mtimeNs) {
			const ino = await resolvePath(path, true)
			await fs.setattr(ino, { mtimeNs })
		},

		async scan(path, visitor) {
			const ino = await resolvePath(path, true)
			const stat = await fs.stat(ino)

			await visitor(path, stat)

			if (stat.type !== FileType.Directory) return

			if (path === '/') {
				// Root: emit everything _fs.scan() produces.
				await fs.scan(async (fsPath, _fsIno, fsStat) => {
					await visitor(fsPath, fsStat)
				})
				return
			}

			// Non-root: _fs.scan() emits canonical filesystem paths, which may
			// differ from `path` when `path` resolves through a symlink (e.g.
			// path='/link' but the real directory is '/real'). We discover the
			// canonical path by matching the resolved ino, then filter descendants
			// against that canonical prefix and remap them back to `path`.
			//
			// Special case: if `ino` is the root inode (e.g. path='/root-link' →
			// '/'), _fs.scan() never emits the root entry itself, so we pre-seed
			// canonicalRoot rather than waiting for a match that never arrives.
			let canonicalRoot: string | null = ino === fs.root() ? '/' : null
			await fs.scan(async (fsPath, fsIno, fsStat) => {
				if (canonicalRoot === null) {
					if (fsIno === ino) canonicalRoot = fsPath
					return // skip everything until we locate the scan root
				}
				const inSubtree = canonicalRoot === '/' || fsPath.startsWith(canonicalRoot + '/')
				if (inSubtree) {
					// For canonicalRoot='/' fsPath already has the leading slash,
					// so path+fsPath produces the correct remapped path.
					// For any other canonicalRoot, fsPath.slice(canonicalRoot.length)
					// starts with '/', giving path+'/child'.
					const remapped = canonicalRoot === '/' ? path + fsPath : path + fsPath.slice(canonicalRoot.length)
					await visitor(remapped, fsStat)
				}
			})
		},
	}
}
