import { createSingleFlight } from './singleFlight'
import type { InodeMeta, Storage } from './storage'
import type { Dirent, DirentMin, Ino, Stat } from './types'
import { FileType } from './types'

/**
 * Path-based filesystem interface built on top of Storage.
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
	 * Delegates to Storage.caps.fullScan() when available —
	 * O(pages) round trips for cloud backends. Falls back to recursive readdir.
	 *
	 * Throws ENOENT if path does not exist.
	 */
	scan(path: string, visitor: (path: string, stat: Stat) => Promise<void>): Promise<void>

	/**
	 * Watch a single path for changes — an inotify-style primitive.
	 *
	 * The listener fires after a change to the path commits, coalesced per
	 * microtask (one logical write = several storage ops = one event). Like
	 * real inotify it tracks both the resolved inode (content/meta edits) AND
	 * the parent dentry, so a delete+recreate or rename/replace that rebinds
	 * the path to a fresh inode still fires (and the next event re-resolves).
	 *
	 * The event carries the `source` the write was tagged with, so callers can
	 * ignore their own writes (sync tags remote-applied pulls; local user
	 * writes carry none). The path need not exist yet — once a dentry binds it,
	 * the watch picks it up.
	 *
	 * Requires `Storage.caps.subscribe`; without it the watch is inert and the
	 * returned unsubscribe is a no-op. Returns a promise of the unsubscribe.
	 */
	watch(path: string, listener: (event: WatchEvent) => void): Promise<() => void>
}

/** Payload delivered to a `volume.watch` listener. */
export interface WatchEvent {
	/** The `MutationOptions.source` the triggering write was tagged with. */
	source?: string
}

export function volume(storage: Storage): Volume {
	const MAX_SYMLINK_DEPTH = 40

	const metaCache = new Map<Ino, InodeMeta>()
	const dirCache = new Map<string, DirentMin | null>()
	const metaRequests = createSingleFlight<Ino, InodeMeta>()
	const dirLookupRequests = createSingleFlight<string, DirentMin | null>()

	function nowNs(): bigint {
		return BigInt(Date.now()) * 1_000_000n
	}

	function dirCacheKey(dirIno: Ino, name: string): string {
		return `${dirIno}:${name}`
	}

	function invalidateDirCache(dirIno: Ino): void {
		const prefix = `${dirIno}:`
		for (const key of dirCache.keys()) {
			if (key.startsWith(prefix)) {
				dirCache.delete(key)
			}
		}
		dirLookupRequests.deleteWhere((key) => key.startsWith(prefix))
	}

	function invalidateIno(ino: Ino): void {
		metaCache.delete(ino)
		metaRequests.delete(ino)
	}

	function makeStat(ino: Ino, meta: InodeMeta): Stat {
		return {
			ino,
			type: meta.type,
			size: meta.size,
			mode: meta.mode,
			mtimeNs: meta.mtimeNs,
			ctimeNs: meta.ctimeNs,
			contentHash: meta.contentHash
		}
	}

	async function getMetaOrThrow(ino: Ino): Promise<InodeMeta> {
		const cached = metaCache.get(ino)
		if (cached) return cached

		return metaRequests.run(ino, async () => {
			const meta = await storage.getMeta(ino)
			if (meta === null) {
				throw new Error(`ENOENT: inode ${ino}`)
			}
			metaCache.set(ino, meta)
			return meta
		})
	}

	async function lookupDirent(dirIno: Ino, name: string): Promise<DirentMin | null> {
		const key = dirCacheKey(dirIno, name)
		if (dirCache.has(key)) {
			return dirCache.get(key) ?? null
		}

		return dirLookupRequests.run(key, async () => {
			const entry = await storage.getDirent(dirIno, name)
			dirCache.set(key, entry)
			return entry
		})
	}

	async function lookupIno(dirIno: Ino, name: string): Promise<Ino | null> {
		return (await lookupDirent(dirIno, name))?.ino ?? null
	}

	type ResolvedPath = {
		ino: Ino
		type: FileType
	}

	/**
	 * Resolve an absolute path to an inode and final type.
	 * followLast controls whether a final symlink component is followed.
	 */
	async function resolvePathInfo(
		path: string,
		followLast: boolean,
		initialDepth = 0
	): Promise<ResolvedPath> {
		const normalized = path.replace(/\/+$/, '') || '/'
		if (normalized === '/') {
			const meta = await getMetaOrThrow(storage.rootIno)
			return { ino: storage.rootIno, type: meta.type }
		}

		const queue: string[] = normalized.split('/').filter((p) => p !== '')
		const inoStack: Ino[] = [storage.rootIno]
		let symlinkDepth = initialDepth
		let resolved: ResolvedPath | null = null

		for (let i = 0; i < queue.length; i++) {
			const name = queue[i]
			if (name === undefined) continue

			if (name === '.') continue

			if (name === '..') {
				if (inoStack.length > 1) inoStack.pop()
				continue
			}

			const isLast = i === queue.length - 1
			const currentIno = inoStack[inoStack.length - 1]
			if (currentIno === undefined) throw new Error(`ENOENT: ${path}`)

			const entry = await lookupDirent(currentIno, name)
			if (entry === null) throw new Error(`ENOENT: ${path}`)

			if (entry.type === FileType.Symlink && (!isLast || followLast)) {
				const meta = await getMetaOrThrow(entry.ino)
				if (++symlinkDepth > MAX_SYMLINK_DEPTH)
					throw new Error('ELOOP: too many levels of symbolic links')

				const target = meta.symlinkTarget
				if (!target) throw new Error(`EINVAL: symlink has no target`)
				const targetParts = target.split('/').filter((p) => p !== '')

				if (target.startsWith('/')) {
					inoStack.splice(0, inoStack.length, storage.rootIno)
				}
				queue.splice(i, 1, ...targetParts)
				i--
			} else {
				inoStack.push(entry.ino)
				resolved = { ino: entry.ino, type: entry.type }
			}
		}

		if (!resolved) {
			const ino = inoStack[inoStack.length - 1]
			if (!ino) throw new Error(`ENOENT: ${path}`)
			const meta = await getMetaOrThrow(ino)
			return { ino, type: meta.type }
		}
		return resolved
	}

	async function resolvePath(path: string, followLast: boolean, initialDepth = 0): Promise<Ino> {
		return (await resolvePathInfo(path, followLast, initialDepth)).ino
	}

	function splitPath(path: string): { dir: string; name: string } {
		const lastSlash = path.lastIndexOf('/')
		const dir = lastSlash === 0 ? '/' : path.slice(0, lastSlash)
		const name = path.slice(lastSlash + 1)
		return { dir, name }
	}

	async function resolveParent(path: string): Promise<{ dirIno: Ino; name: string }> {
		const { dir, name } = splitPath(path)
		const dirIno = await resolvePath(dir, true)
		return { dirIno, name }
	}

	async function readdirAll(dirIno: Ino): Promise<Dirent[]> {
		const entries: Dirent[] = []
		let cursor = ''
		do {
			const batch = await storage.listDirents(dirIno, cursor)
			entries.push(...batch.entries.map((e) => ({ ino: e.ino, name: e.name, type: e.type })))
			cursor = batch.next
		} while (cursor !== '')
		return entries
	}

	async function createNode(dirIno: Ino, name: string, meta: InodeMeta): Promise<Ino> {
		if (storage.caps?.atomicCreate) {
			const ino = await storage.caps.atomicCreate(dirIno, name, meta)
			invalidateDirCache(dirIno)
			return ino
		}

		const ino = crypto.randomUUID()
		await storage.setMeta(ino, meta)
		await storage.putDirent(dirIno, name, { ino, type: meta.type })
		dirCache.set(dirCacheKey(dirIno, name), { ino, type: meta.type })
		metaCache.set(ino, meta)
		return ino
	}

	async function unlinkIno(dirIno: Ino, name: string): Promise<void> {
		const entry = await storage.getDirent(dirIno, name)
		if (entry === null) throw new Error(`ENOENT: ${name}`)
		await storage.deleteDirent(dirIno, name)
		await storage.deleteInode(entry.ino)
		invalidateDirCache(dirIno)
		invalidateIno(entry.ino)
	}

	const vol: Volume = {
		async stat(path) {
			const ino = await resolvePath(path, true)
			return makeStat(ino, await getMetaOrThrow(ino))
		},

		async lstat(path) {
			const ino = await resolvePath(path, false)
			return makeStat(ino, await getMetaOrThrow(ino))
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
			return storage.caps?.getXattr?.(ino, name) ?? null
		},

		async setXattr(path, name, value) {
			const ino = await resolvePath(path, true)
			await storage.caps?.setXattr?.(ino, name, value)
		},

		async listXattr(path) {
			const ino = await resolvePath(path, true)
			return storage.caps?.listXattrs?.(ino) ?? []
		},

		async removeXattr(path, name) {
			const ino = await resolvePath(path, true)
			await storage.caps?.removeXattr?.(ino, name)
		},

		async readFile(path) {
			const resolved = await resolvePathInfo(path, true)
			if (resolved.type === FileType.Directory) {
				throw new Error(`EISDIR: ${path}`)
			}
			return storage.getBlob(resolved.ino)
		},

		async writeFile(path, data) {
			let ino: Ino
			let resolved: Ino | null = null
			try {
				resolved = await resolvePath(path, true)
			} catch (e) {
				if (!(e as Error).message.startsWith('ENOENT')) throw e
			}

			if (resolved !== null) {
				const meta = await getMetaOrThrow(resolved)
				if (meta.type === FileType.Directory) throw new Error(`EISDIR: ${path}`)
				ino = resolved
			} else {
				const { dirIno, name } = await resolveParent(path)
				const now = nowNs()
				ino = await createNode(dirIno, name, {
					type: FileType.Regular,
					size: 0n,
					mode: 0o644,
					mtimeNs: now,
					ctimeNs: now
				})
			}

			await storage.putBlob(ino, data)
			invalidateIno(ino)
		},

		async appendFile(path, data) {
			let ino: Ino
			let resolved: Ino | null = null
			try {
				resolved = await resolvePath(path, true)
			} catch (e) {
				if (!(e as Error).message.startsWith('ENOENT')) throw e
			}

			if (resolved !== null) {
				const meta = await getMetaOrThrow(resolved)
				if (meta.type === FileType.Directory) throw new Error(`EISDIR: ${path}`)
				ino = resolved
				const existing = await storage.getBlob(ino)
				const merged = new Uint8Array(existing.length + data.length)
				merged.set(existing)
				merged.set(data, existing.length)
				await storage.putBlob(ino, merged)
			} else {
				const { dirIno, name } = await resolveParent(path)
				const now = nowNs()
				ino = await createNode(dirIno, name, {
					type: FileType.Regular,
					size: 0n,
					mode: 0o644,
					mtimeNs: now,
					ctimeNs: now
				})
				await storage.putBlob(ino, data)
			}
			invalidateIno(ino)
		},

		async mkdir(path, opts) {
			const recursive = opts?.recursive ?? false
			const mode = opts?.mode ?? 0o755

			if (recursive) {
				const parts = path.split('/').filter((p) => p !== '')
				let current = '/'
				for (const part of parts) {
					const parentPath = current
					current = current === '/' ? `/${part}` : `${current}/${part}`
					const parentIno = await resolvePath(parentPath, true)
					const existingIno = await lookupIno(parentIno, part)
					if (existingIno !== null) continue
					try {
						const now = nowNs()
						await createNode(parentIno, part, {
							type: FileType.Directory,
							size: 0n,
							mode,
							mtimeNs: now,
							ctimeNs: now
						})
					} catch (e) {
						if (!(e instanceof Error) || !e.message.startsWith('EEXIST')) throw e
					}
				}
				return
			}

			const { dirIno, name } = await resolveParent(path)
			const existingIno = await lookupIno(dirIno, name)
			if (existingIno !== null) {
				throw new Error(`EEXIST: ${path}`)
			}
			const now = nowNs()
			await createNode(dirIno, name, {
				type: FileType.Directory,
				size: 0n,
				mode,
				mtimeNs: now,
				ctimeNs: now
			})
		},

		async readdir(path) {
			const ino = await resolvePath(path, true)
			const meta = await getMetaOrThrow(ino)
			if (meta.type !== FileType.Directory) {
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

			const meta = await getMetaOrThrow(ino)
			if (meta.type === FileType.Directory) {
				const entries = await readdirAll(ino)
				if (entries.length > 0 && !recursive) {
					throw new Error(`ENOTEMPTY: ${path}`)
				}
				if (recursive) {
					for (const entry of entries) {
						const childPath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`
						await vol.rm(childPath, { recursive: true })
					}
				}
			}

			const { dirIno, name } = await resolveParent(path)
			await unlinkIno(dirIno, name)
		},

		async rename(oldPath, newPath) {
			const { dirIno: oldDirIno, name: oldName } = await resolveParent(oldPath)
			const { dirIno: newDirIno, name: newName } = await resolveParent(newPath)

			if (storage.caps?.atomicMove) {
				const displaced = await storage.caps.atomicMove(oldDirIno, oldName, newDirIno, newName)
				invalidateDirCache(oldDirIno)
				invalidateDirCache(newDirIno)
				if (displaced !== null) invalidateIno(displaced)
				return
			}

			const source = await storage.getDirent(oldDirIno, oldName)
			if (source === null) throw new Error(`ENOENT: ${oldName}`)

			const displaced = await storage.getDirent(newDirIno, newName)
			await storage.putDirent(newDirIno, newName, { ino: source.ino, type: source.type })
			await storage.deleteDirent(oldDirIno, oldName)

			if (displaced && displaced.ino !== source.ino) {
				await storage.deleteInode(displaced.ino)
				invalidateIno(displaced.ino)
			}

			invalidateDirCache(oldDirIno)
			invalidateDirCache(newDirIno)
		},

		async cp(src, dest, opts) {
			const recursive = opts?.recursive ?? false

			const srcIno = await resolvePath(src, true)
			const srcMeta = await getMetaOrThrow(srcIno)

			if (srcMeta.type === FileType.Directory) {
				if (!recursive) throw new Error(`EISDIR: ${src}`)

				let destExists = false
				try {
					const destIno = await resolvePath(dest, true)
					const destMeta = await getMetaOrThrow(destIno)
					if (destMeta.type !== FileType.Directory) throw new Error(`ENOTDIR: ${dest}`)
					destExists = true
				} catch (e) {
					if (!(e as Error).message.startsWith('ENOENT')) throw e
				}

				if (!destExists) {
					await vol.mkdir(dest, { mode: srcMeta.mode })
				}

				const entries = await readdirAll(srcIno)
				for (const entry of entries) {
					const srcChild = src === '/' ? `/${entry.name}` : `${src}/${entry.name}`
					const destChild = dest === '/' ? `/${entry.name}` : `${dest}/${entry.name}`
					await vol.cp(srcChild, destChild, { recursive })
				}
			} else {
				try {
					const destIno = await resolvePath(dest, true)
					const destMeta = await getMetaOrThrow(destIno)
					if (destMeta.type === FileType.Directory) throw new Error(`EISDIR: ${dest}`)
				} catch (e) {
					if (!(e as Error).message.startsWith('ENOENT')) throw e
				}

				const data = await vol.readFile(src)
				await vol.writeFile(dest, data)
			}
		},

		async symlink(target, path) {
			const { dirIno, name } = await resolveParent(path)
			const existingIno = await lookupIno(dirIno, name)
			if (existingIno !== null) throw new Error(`EEXIST: ${path}`)
			const now = nowNs()
			await createNode(dirIno, name, {
				type: FileType.Symlink,
				size: BigInt(new TextEncoder().encode(target).length),
				mode: 0o777,
				mtimeNs: now,
				ctimeNs: now,
				symlinkTarget: target
			})
		},

		async readlink(path) {
			const ino = await resolvePath(path, false)
			const meta = await getMetaOrThrow(ino)
			if (meta.type !== FileType.Symlink) throw new Error(`EINVAL: ${path} is not a symlink`)
			if (!meta.symlinkTarget) throw new Error(`EINVAL: symlink has no target`)
			return meta.symlinkTarget
		},

		async chmod(path, mode) {
			const ino = await resolvePath(path, true)
			await storage.setMeta(ino, { mode })
			invalidateIno(ino)
		},

		async utimes(path, mtimeNs) {
			const ino = await resolvePath(path, true)
			await storage.setMeta(ino, { mtimeNs })
			invalidateIno(ino)
		},

		async scan(path, visitor) {
			const ino = await resolvePath(path, true)
			const meta = await getMetaOrThrow(ino)

			await visitor(path, makeStat(ino, meta))

			if (meta.type !== FileType.Directory) return

			if (storage.caps?.fullScan) {
				const inoToPath = new Map<Ino, string>([[storage.rootIno, '/']])
				let cursor = ''
				do {
					const { entries, next } = await storage.caps.fullScan(cursor)
					for (const e of entries) {
						const dir = inoToPath.get(e.dirIno) ?? '/'
						const ePath = dir === '/' ? `/${e.name}` : `${dir}/${e.name}`
						inoToPath.set(e.ino, ePath)
						metaCache.set(e.ino, e.meta)
						dirCache.set(dirCacheKey(e.dirIno, e.name), { ino: e.ino, type: e.meta.type })
						// Filter to descendants of the requested path
						if (path === '/' || ePath === path || ePath.startsWith(`${path}/`)) {
							await visitor(ePath, makeStat(e.ino, e.meta))
						}
					}
					cursor = next
				} while (cursor !== '')
				return
			}

			// Recursive fallback
			async function walk(dirIno: Ino, dirPath: string): Promise<void> {
				let cursor = ''
				do {
					const { entries, next } = await storage.listDirents(dirIno, cursor)
					for (const e of entries) {
						const ePath = dirPath === '/' ? `/${e.name}` : `${dirPath}/${e.name}`
						const eMeta = await storage.getMeta(e.ino)
						if (eMeta === null) continue
						metaCache.set(e.ino, eMeta)
						dirCache.set(dirCacheKey(dirIno, e.name), { ino: e.ino, type: e.type })
						await visitor(ePath, makeStat(e.ino, eMeta))
						if (e.type === FileType.Directory) await walk(e.ino, ePath)
					}
					cursor = next
				} while (cursor !== '')
			}
			await walk(ino, path)
		},

		async watch(path, listener) {
			const subscribe = storage.caps?.subscribe
			if (!subscribe) return () => {}

			// Track the resolved inode (content/meta edits) and the parent dentry
			// (rebinds). The path need not exist yet — dirIno/name bind it once the
			// parent exists.
			let targetIno: Ino | null = null
			let dirIno: Ino | null = null
			let name = ''
			async function resolve(): Promise<void> {
				targetIno = await resolvePath(path, true).catch(() => null)
				const parent = await resolveParent(path).catch(() => null)
				dirIno = parent?.dirIno ?? null
				name = parent?.name ?? ''
			}
			await resolve()

			let scheduled = false
			let needsResolve = false
			let definiteFire = false
			let pendingSource: string | undefined

			return subscribe((change) => {
				const hitsIno =
					targetIno !== null &&
					change.ino === targetIno &&
					(change.kind === 'meta' || change.kind === 'content')
				const hitsDentry =
					change.kind === 'dirent' && change.dirIno === dirIno && change.name === name
				// While the parent chain is incomplete (dirIno still null) we can't
				// know which dentry will bind the path, so any dir mutation is a
				// candidate: re-resolve and fire only if it actually bound the file.
				const mayBind = dirIno === null && change.kind === 'dirent'
				if (!hitsIno && !hitsDentry && !mayBind) return
				pendingSource = change.source
				if (hitsIno || hitsDentry) definiteFire = true
				if (hitsDentry || mayBind) needsResolve = true
				// Coalesce the several storage ops of one logical write into one event.
				if (scheduled) return
				scheduled = true
				queueMicrotask(async () => {
					scheduled = false
					const fire = definiteFire
					const wasUnbound = dirIno === null && targetIno === null
					definiteFire = false
					if (needsResolve) {
						needsResolve = false
						await resolve()
					}
					// A speculative re-resolve that still didn't bind the file (some
					// unrelated dir was created) is not an event.
					if (fire || (wasUnbound && targetIno !== null)) listener({ source: pendingSource })
				})
			})
		}
	}

	// Keep the path caches coherent with writes that bypass this wrapper. Sync
	// applies remote pulls straight to Storage (see synced.ts/applyOp), so without
	// this a `stat` after a pull could return stale meta. Driving invalidation off
	// the storage feed covers both our own writes (harmless re-invalidation) and
	// foreign ones (the actual fix).
	storage.caps?.subscribe?.((change) => {
		if (change.kind === 'dirent' && change.dirIno !== undefined) invalidateDirCache(change.dirIno)
		invalidateIno(change.ino)
	})

	return vol
}

function chrootPath(root: string, path: string): string {
	if (!path.startsWith('/')) throw new Error(`path must be absolute: ${path}`)
	const parts: string[] = []
	for (const part of path.split('/')) {
		if (!part || part === '.') continue
		if (part === '..') {
			if (parts.length === 0) throw new Error(`path escapes chroot: ${path}`)
			parts.pop()
			continue
		}
		parts.push(part)
	}
	return parts.length ? `${root}/${parts.join('/')}` : root
}

export function chroot(fs: Volume, root: string): Volume {
	const at = (path: string) => chrootPath(root, path)
	return {
		stat: (path) => fs.stat(at(path)),
		lstat: (path) => fs.lstat(at(path)),
		exists: (path) => fs.exists(at(path)),
		getXattr: (path, name) => fs.getXattr(at(path), name),
		setXattr: (path, name, value) => fs.setXattr(at(path), name, value),
		listXattr: (path) => fs.listXattr(at(path)),
		removeXattr: (path, name) => fs.removeXattr(at(path), name),
		readFile: (path) => fs.readFile(at(path)),
		writeFile: (path, data) => fs.writeFile(at(path), data),
		appendFile: (path, data) => fs.appendFile(at(path), data),
		mkdir: (path, opts) => fs.mkdir(at(path), opts),
		readdir: (path) => fs.readdir(at(path)),
		rm: (path, opts) => fs.rm(at(path), opts),
		rename: (oldPath, newPath) => fs.rename(at(oldPath), at(newPath)),
		cp: (src, dest, opts) => fs.cp(at(src), at(dest), opts),
		symlink: async () => {
			throw new Error('symlink not supported in chroot')
		},
		readlink: (path) => fs.readlink(at(path)),
		chmod: (path, mode) => fs.chmod(at(path), mode),
		utimes: (path, mtimeNs) => fs.utimes(at(path), mtimeNs),
		scan: (path, visitor) =>
			fs.scan(at(path), async (realPath, stat) => {
				await visitor(realPath.slice(root.length) || '/', stat)
			}),
		watch: (path, listener) => fs.watch(at(path), listener)
	}
}
