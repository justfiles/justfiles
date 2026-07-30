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
	 *
	 * Moves the file's `mtimeNs`/`ctimeNs` to now, so mtime means "when these bytes
	 * last changed" and an app can sort by recency. A sync-applied write instead
	 * carries the ORIGIN's mtime (it is the same edit, not a new one). Directory
	 * mtime is NOT maintained — no caller reads it.
	 *
	 * `exclusive` and `update` are the two ends of one question — what must be true of
	 * the path before these bytes land — and this call is the only place it can be
	 * asked without a gap, because it is the call that resolves the path.
	 *
	 * With `exclusive: true` this is a CREATE, not a write: it throws EEXIST if the
	 * path is already taken. That makes it a *claim* on a name rather than a probe —
	 * `exists()` followed by `writeFile` is a TOCTOU, and the loser of the race has
	 * its file overwritten. The check and the create are one operation in the
	 * backend (`atomicCreate`: `O_EXCL`, a single IndexedDB transaction, a
	 * synchronous map check), so concurrent writers are decided by the storage. A
	 * backend without that capability falls back to a best-effort pre-check.
	 *
	 * With `update: true` it is an EDIT, not a create: ENOENT if nothing is there
	 * (`open` without `O_CREAT`). A plain write brings a file into being, and with it
	 * every missing parent folder — so a caller holding a path that has since been
	 * moved or deleted silently *recreates* the tree it remembers instead of failing.
	 * An editor autosaving to the note it has open wants this: the write is where the
	 * path is proven still real, so it cannot be stale by the time the bytes land.
	 */
	writeFile(
		path: string,
		data: Uint8Array,
		opts?: { exclusive?: boolean; update?: boolean }
	): Promise<void>

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
	 *
	 * With `exclusive: true` the destination must be FREE: EEXIST if a file or a
	 * directory already holds that name, so a caller can retry under another name
	 * instead of destroying a stranger's data.
	 *
	 * Unlike `writeFile`'s `exclusive`, this is a CHECK AND THEN a move, not one
	 * operation — no POSIX rename is both atomic and no-replace (`renameat2` and
	 * `renamex_np` are not reachable from Node), and emulating one costs more than it
	 * buys: claiming the destination first is not a reservation in a shared store,
	 * and `link`+`unlink` is no longer a move. So the guarantee here is scoped
	 * honestly: sequential writers never overwrite each other, and two writers
	 * racing for the SAME new name in the same instant can still have one replaced.
	 * Order your own writes if that matters; this refuses the destination that is
	 * taken when it looks.
	 */
	rename(oldPath: string, newPath: string, opts?: { exclusive?: boolean }): Promise<void>

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
	 * With `{ recursive: true }` the watch instead reports STRUCTURAL changes
	 * — entries created/removed/renamed — at or under `path`, plus a rebind of
	 * `path` itself or of any ancestor (which takes the whole subtree with it),
	 * coalesced per microtask; pair it with a `scan` of the same path to rebuild the
	 * listing. Content/meta edits to existing files do NOT fire — watch the concrete
	 * file for those. That holds for a pulled edit too: sync applying a put over a
	 * path this replica already holds is an edit, not structure (see
	 * `applyJournaledOver`). This is the substrate for a directory browser's
	 * auto-refresh.
	 *
	 * Requires `Storage.caps.subscribe`; without it the watch is inert and the
	 * returned unsubscribe is a no-op. Returns a promise of the unsubscribe.
	 */
	watch(
		path: string,
		listener: (event: WatchEvent) => void,
		opts?: { recursive?: boolean }
	): Promise<() => void>
}

/** Payload delivered to a `volume.watch` listener. */
export interface WatchEvent {
	/** The `MutationOptions.source` the triggering write was tagged with. */
	source?: string
}

// Used ONLY to pre-compute a content hash before a create-with-content-already-
// known claim (see write-then-publish in `writeFile`) — every backend already
// implements the same algorithm privately for its own `putBlob`; this one has no
// closure state, so it stays module-level rather than being re-created per `volume()`.
async function sha256Hex(data: Uint8Array): Promise<string> {
	const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
	const digest = await crypto.subtle.digest('SHA-256', buf)
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
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
			// Cache a HIT, never a MISS: a miss is only ever true "as of the last check" --
			// any writer this Volume can't observe (a different tab, process, or Storage
			// instance over the same backing store) can falsify it at any moment, with no
			// event to correct it by. A stale hit just risks briefly-wrong content
			// (recoverable); a stale miss is a permanent, self-inflicted ENOENT/false
			// "doesn't exist" that nothing will ever revisit.
			if (entry !== null) dirCache.set(key, entry)
			return entry
		})
	}

	async function lookupIno(dirIno: Ino, name: string): Promise<Ino | null> {
		return (await lookupDirent(dirIno, name))?.ino ?? null
	}

	type ResolvedPath = {
		ino: Ino
		type: FileType
		// Where the walk LANDED: `.`/`..` folded away and every traversed symlink
		// replaced by its target, so this is the path the change feed reports entries
		// under. `/alias/trips` (alias -> /notes) lands on `/notes/trips`.
		path: string
	}

	/**
	 * Resolve an absolute path to an inode, its final type, and the canonical path
	 * it landed on.
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
			return { ino: storage.rootIno, type: meta.type, path: '/' }
		}

		const queue: string[] = normalized.split('/').filter((p) => p !== '')
		const inoStack: Ino[] = [storage.rootIno]
		// The names behind `inoStack`, kept in lockstep so the walk can report where
		// it ended up rather than what the caller spelled.
		const names: string[] = []
		let symlinkDepth = initialDepth
		let resolved: ResolvedPath | null = null

		for (let i = 0; i < queue.length; i++) {
			const name = queue[i]
			if (name === undefined) continue

			if (name === '.') continue

			if (name === '..') {
				if (inoStack.length > 1) {
					inoStack.pop()
					names.pop()
				}
				// We are no longer at the entry we last descended into, so the destination
				// has to be re-read from the stack below: `/a/b/..` is `/a`, not `/a/b`.
				resolved = null
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
					names.length = 0
				}
				queue.splice(i, 1, ...targetParts)
				i--
			} else {
				inoStack.push(entry.ino)
				names.push(name)
				resolved = { ino: entry.ino, type: entry.type, path: `/${names.join('/')}` }
			}
		}

		if (!resolved) {
			const ino = inoStack[inoStack.length - 1]
			if (!ino) throw new Error(`ENOENT: ${path}`)
			const meta = await getMetaOrThrow(ino)
			return { ino, type: meta.type, path: names.length ? `/${names.join('/')}` : '/' }
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

		async writeFile(path, data, opts) {
			let ino: Ino
			let resolved: Ino | null = null
			try {
				resolved = await resolvePath(path, true)
			} catch (e) {
				if (!(e as Error).message.startsWith('ENOENT')) throw e
			}

			if (resolved !== null) {
				if (opts?.exclusive) throw new Error(`EEXIST: ${path}`)
				const meta = await getMetaOrThrow(resolved)
				if (meta.type === FileType.Directory) throw new Error(`EISDIR: ${path}`)
				ino = resolved
				await storage.putBlob(ino, data)
			} else {
				// An edit has nothing to edit. Refused HERE, where the path was just
				// resolved, so no caller can create a file (and its parents) from a path it
				// no longer holds.
				if (opts?.update) throw new Error(`ENOENT: ${path}`)
				const { dirIno, name } = await resolveParent(path)
				const now = nowNs()
				const meta: InodeMeta = {
					type: FileType.Regular,
					size: 0n,
					mode: 0o644,
					mtimeNs: now,
					ctimeNs: now
				}
				// Write-then-publish (docs/write-then-publish.html): on a backend with a
				// hash-addressed content store, make the bytes durable BEFORE the name is
				// claimed, and carry the resulting `contentHash` in the claim's own meta. The
				// claim and "the content is there" then become ONE atomic fact, so a caller
				// that loses the race below and reads back the winner never observes a
				// transiently empty file. Backends without the cap keep the old create-then-
				// fill order (the trailing putBlob below).
				let contentWritten = false
				if (storage.caps?.content) {
					const hash = await sha256Hex(data)
					await storage.caps.content.putByHash(hash, data)
					meta.size = BigInt(data.length)
					meta.contentHash = hash
					contentWritten = true
				}
				// `createNode` throws EEXIST when a concurrent writer took the name between
				// the resolve above and here. For `exclusive: true` that IS the claim working
				// as intended — propagate it. A PLAIN write promises create-OR-overwrite,
				// never a claim, so it must not surface that internal detail: catch it and
				// retry as an update against whoever won, the same as if resolvePath above
				// had found them first. Safe to retry — atomicCreate throws before any
				// mutation, so a failed attempt (and an already-written write-then-publish
				// blob, if any) leaves nothing to undo.
				try {
					ino = await createNode(dirIno, name, meta)
					if (!contentWritten) {
						await storage.putBlob(ino, data)
					}
				} catch (e) {
					if (!(e instanceof Error) || !e.message.startsWith('EEXIST') || opts?.exclusive) throw e
					// Re-resolve the FULL PATH the same way the top of this function does --
					// NOT the raw dirent via lookupIno, which would land on a SYMLINK's own
					// inode instead of its target. A dangling symlink already occupying `name`
					// makes createNode throw this exact EEXIST with no writer racing at all;
					// writing straight into that raw ino would silently strand the bytes in a
					// slot nothing ever reads through the path again.
					let winner: Ino
					try {
						winner = await resolvePath(path, true)
					} catch (e2) {
						if (!(e2 as Error).message.startsWith('ENOENT')) throw e2
						throw e // the name IS taken (that's what EEXIST just proved), but the
						// path still doesn't resolve to anything -- e.g. a dangling symlink.
						// The original EEXIST says that more honestly than the ENOENT would.
					}
					const winnerMeta = await getMetaOrThrow(winner)
					if (winnerMeta.type === FileType.Directory) throw new Error(`EISDIR: ${path}`)
					await storage.putBlob(winner, data)
					ino = winner
				}
			}

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
					if (existingIno !== null) {
						// `mkdir -p` may pass over a component that is already a DIRECTORY. It may not
						// pass over a file and report that the folder exists: the caller asked for a
						// place to put things, and a caller that has to check first can always be
						// overtaken between the check and this call.
						const existing = await getMetaOrThrow(existingIno)
						if (existing.type !== FileType.Directory) {
							throw new Error(current === path ? `EEXIST: ${path}` : `ENOTDIR: ${current}`)
						}
						continue
					}
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

		async rename(oldPath, newPath, opts) {
			const { dirIno: oldDirIno, name: oldName } = await resolveParent(oldPath)
			const { dirIno: newDirIno, name: newName } = await resolveParent(newPath)

			if (opts?.exclusive) {
				const taken = await storage.getDirent(newDirIno, newName)
				const source = await storage.getDirent(oldDirIno, oldName)
				if (taken && taken.ino !== source?.ino) throw new Error(`EEXIST: ${newPath}`)
			}

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

		async watch(path, listener, opts) {
			const subscribe = storage.caps?.subscribe
			if (!subscribe) return () => {}

			// Recursive: a STRUCTURAL change signal for the subtree at `path`. Only
			// dirent mutations (create/remove/rename) reshape a tree's entry set; content
			// edits to existing files keep the listing identical, so they don't fire.
			// Coalesce the several ops of one logical write into a single event.
			if (opts?.recursive) {
				// Compare against where the root RESOLVES, not how it was spelled: every
				// other operation on this volume follows symlinks, so a watch on an alias
				// has to see the events its own reads produce (they arrive under the
				// target's path). Pinned once here, as `inotify_add_watch` pins at add
				// time; re-point the symlink and you re-watch. A root that does not exist
				// yet has nothing to resolve through, so it stays as spelled.
				const spelled = normalizePath(path)
				let root = spelled
				try {
					const landed = await resolvePathInfo(spelled || '/', true)
					root = landed.path === '/' ? '' : landed.path
				} catch {
					// Not created yet: nothing to resolve through, so compare as spelled.
				}
				let scheduled = false
				let pendingSource: string | undefined
				return subscribe((change) => {
					if (change.kind !== 'dirent') return
					// Scope: only what can reshape this subtree's listing. A change with no
					// path is unlocatable (its parent is already unlinked), so it fires —
					// a spurious re-scan is recoverable, a missed change is not.
					if (!touchesSubtree(root, change.path)) return
					pendingSource = change.source
					if (scheduled) return
					scheduled = true
					queueMicrotask(() => {
						scheduled = false
						listener({ source: pendingSource })
					})
				})
			}

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

/**
 * Can a dirent change at `path` reshape the listing of the subtree at `root`?
 * Three ways, and no others:
 *   - it IS the root (the watched directory itself came or went),
 *   - it is INSIDE the root (an entry of the listing changed),
 *   - it is an ANCESTOR of the root (the way in was rebound — rename `/notes` to
 *     `/archive` and everything under `/notes/trips` has vanished without a
 *     single event under that path, because descendants keep their
 *     parent-ino-keyed dirents and only the moved entry is reported).
 * `root` is normalised, so '' is the volume root and contains everything. An
 * unknown (undefined) path counts as relevant — see the caller.
 */
function touchesSubtree(root: string, path: string | undefined): boolean {
	if (path === undefined || root === '') return true
	if (path === root) return true
	return path.startsWith(`${root}/`) || root.startsWith(`${path}/`)
}

/**
 * Canonical form of an absolute path: no trailing slash, no empty or `.`
 * segments, `..` resolved. Returns '' for the root so the result COMPOSES by
 * concatenation — it is the chroot mapping's tail, and as a watch root it
 * prefixes every path in the volume.
 *
 * Every path-taking operation resolves a path this way (`resolvePathInfo` walks
 * the same segments), so a listener that compares paths textually has to do it
 * too, or `/notes/../notes` watches nothing.
 */
function normalizePath(path: string): string {
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
	return parts.length ? `/${parts.join('/')}` : ''
}

function chrootPath(root: string, path: string): string {
	return `${root}${normalizePath(path)}` || root
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
		writeFile: (path, data, opts) => fs.writeFile(at(path), data, opts),
		appendFile: (path, data) => fs.appendFile(at(path), data),
		mkdir: (path, opts) => fs.mkdir(at(path), opts),
		readdir: (path) => fs.readdir(at(path)),
		rm: (path, opts) => fs.rm(at(path), opts),
		rename: (oldPath, newPath, opts) => fs.rename(at(oldPath), at(newPath), opts),
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
		watch: (path, listener, opts) => fs.watch(at(path), listener, opts)
	}
}
