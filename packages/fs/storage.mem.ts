import type { InodeMeta, Storage, StorageCapabilities, StorageChange } from './storage'
import type { MutationObserver, TreePort } from './storage.shared'
import { joinPath } from './storage.shared'
import type { DirentMin, Ino } from './types'
import { FileType } from './types'

/**
 * `mintIno` lets a caller control inode identity — e.g. a numeric-ino backend
 * (like real OS inodes) vs a UUID one — so heterogeneous ino spaces can be
 * exercised. `atomicCreate` always mints via it (defaulting to `crypto.randomUUID`
 * when not supplied), matching every other shipped backend (idb, node, sqlite): a
 * bare `memStorage()` is NOT a degraded, non-atomic mode. Root is always `'1'`.
 */
export type MemStorageExtension<Attached extends object> = {
	observer: MutationObserver
	attach(tree: TreePort): Attached
}

export function memStorage<Attached extends object = Record<never, never>>(opts?: {
	mintIno?: () => Ino
	extension?: MemStorageExtension<Attached>
}): Storage & Attached {
	const metas = new Map<Ino, InodeMeta>()
	// Content is hash-addressed: the inode holds a `contentHash` reference and the
	// bytes live here under that hash. This deduplicates content and permits direct access.
	const hashBlobs = new Map<string, Uint8Array>()
	const dirs = new Map<string, DirentMin>() // key: `${dirIno}\0${name}`
	const xattrs = new Map<Ino, Map<string, Uint8Array>>()
	const rootIno = '1'
	const mintIno = opts?.mintIno
	// Reverse index child ino -> { parent, name } (one dirent per ino; hard links
	// unsupported). Powers O(depth) `pathOf(ino)` for in-transaction path stamping.
	const parentOf = new Map<Ino, { parent: Ino; name: string }>()
	const listeners = new Set<(change: StorageChange) => void>()
	function emit(change: StorageChange): void {
		if (listeners.size === 0) return
		for (const fn of [...listeners]) fn(change)
	}

	metas.set(rootIno, {
		type: FileType.Directory,
		size: 0n,
		mode: 0o755,
		mtimeNs: 0n,
		ctimeNs: 0n
	})

	function dirKey(dirIno: Ino, name: string): string {
		return `${dirIno}\0${name}`
	}

	function hasDirentReference(ino: Ino): boolean {
		for (const entry of dirs.values()) {
			if (entry.ino === ino) return true
		}
		return false
	}

	function defaultMode(type: FileType): number {
		return type === FileType.Directory ? 0o755 : type === FileType.Symlink ? 0o777 : 0o644
	}

	function mint(): Ino {
		return mintIno ? mintIno() : crypto.randomUUID()
	}

	async function sha256Hex(data: Uint8Array): Promise<string> {
		const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
		const digest = await crypto.subtle.digest('SHA-256', buf)
		return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
	}

	/** Resolve a canonical path to an ino by walking dirents; null if absent. */
	function resolveIno(p: string): Ino | null {
		if (p === '/') return rootIno
		let cur: Ino = rootIno
		for (const seg of p.slice(1).split('/')) {
			const entry = dirs.get(dirKey(cur, seg))
			if (!entry) return null
			cur = entry.ino
		}
		return cur
	}

	/** Ensure every segment of a directory path exists; return the deepest ino. */
	function ensureDir(p: string): Ino {
		if (p === '/') return rootIno
		let cur: Ino = rootIno
		for (const seg of p.slice(1).split('/')) {
			const key = dirKey(cur, seg)
			const entry = dirs.get(key)
			if (entry) {
				cur = entry.ino
				continue
			}
			const ino = mint()
			metas.set(ino, { type: FileType.Directory, size: 0n, mode: 0o755, mtimeNs: 0n, ctimeNs: 0n })
			dirs.set(key, { ino, type: FileType.Directory })
			parentOf.set(ino, { parent: cur, name: seg })
			cur = ino
		}
		return cur
	}

	/** Resolve ino -> canonical path by walking `parentOf` up to root; null if unlinked. */
	function pathOf(ino: Ino): string | null {
		if (ino === rootIno) return '/'
		const segs: string[] = []
		let cur: Ino = ino
		while (cur !== rootIno) {
			const p = parentOf.get(cur)
			if (!p) return null
			segs.unshift(p.name)
			cur = p.parent
		}
		return `/${segs.join('/')}`
	}

	/** User-xattr snapshot for an inode. */
	function xattrRecord(ino: Ino): Record<string, Uint8Array> {
		const m = xattrs.get(ino)
		if (!m) return {}
		return Object.fromEntries(m)
	}

	// The in-memory backend is synchronous and atomic, so emits fire inline.
	const treePort: TreePort = {
		mintIno: mint,
		async resolveIno(path) {
			return resolveIno(path)
		},
		async pathOf(ino) {
			return pathOf(ino)
		},
		async enumerateSubtree(ino) {
			return enumerateSubtree(ino)
		},
		async ensureDirPath(path) {
			return ensureDir(path)
		},
		async getDirent(dirIno, name) {
			const entry = dirs.get(dirKey(dirIno, name))
			return entry ? { ino: entry.ino, type: entry.type } : null
		},
		async readMetaXattrs(ino) {
			const meta = metas.get(ino)
			return meta ? { meta, xattrs: xattrRecord(ino) } : null
		},
		async upsertInode(ino, meta, contentHash, snapshot, content) {
			if (contentHash !== undefined && content !== undefined)
				hashBlobs.set(contentHash, content.slice())
			metas.set(ino, { ...meta, contentHash })
			// Replace user xattrs with the snapshot. Keep backend-owned attributes.
			const existing = xattrs.get(ino)
			if (existing)
				for (const k of [...existing.keys()]) if (!k.startsWith('trusted.')) existing.delete(k)
			if (Object.keys(snapshot).length > 0) {
				let m = xattrs.get(ino)
				if (!m) {
					m = new Map()
					xattrs.set(ino, m)
				}
				for (const [k, v] of Object.entries(snapshot)) m.set(k, v)
			}
		},
		async setDirent(dirIno, name, ino, type) {
			dirs.set(dirKey(dirIno, name), { ino, type })
			parentOf.set(ino, { parent: dirIno, name })
		},
		async deleteDirent(dirIno, name) {
			const existing = dirs.get(dirKey(dirIno, name))
			dirs.delete(dirKey(dirIno, name))
			if (existing) parentOf.delete(existing.ino)
		},
		async deleteInodeIfUnreferenced(ino) {
			if (hasDirentReference(ino)) return
			metas.delete(ino)
			xattrs.delete(ino)
		},
		async dirHasLiveChildren(ino) {
			const prefix = `${ino}\0`
			for (const key of dirs.keys()) if (key.startsWith(prefix)) return true
			return false
		},
		emit
	}

	const observer = opts?.extension?.observer

	/** All paths in the subtree rooted at `ino`, as `{ ino, rel }` (root rel = ''). */
	function enumerateSubtree(ino: Ino): { ino: Ino; rel: string }[] {
		const out: { ino: Ino; rel: string }[] = [{ ino, rel: '' }]
		const prefix = `${ino}\0`
		for (const [key, entry] of dirs) {
			if (!key.startsWith(prefix)) continue
			const name = key.slice(prefix.length)
			for (const child of enumerateSubtree(entry.ino))
				out.push({ ino: child.ino, rel: `/${name}${child.rel}` })
		}
		return out
	}

	const implemented = {
		async getXattr(ino, name) {
			return xattrs.get(ino)?.get(name)?.slice() ?? null
		},
		async setXattr(ino, name, value) {
			let m = xattrs.get(ino)
			if (!m) {
				m = new Map()
				xattrs.set(ino, m)
			}
			m.set(name, value.slice())
		},
		async listXattrs(ino) {
			return [...(xattrs.get(ino)?.keys() ?? [])]
		},
		async removeXattr(ino, name) {
			const m = xattrs.get(ino)
			if (!m) return
			m.delete(name)
			if (m.size === 0) xattrs.delete(ino)
		},

		subscribe(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},

		// Atomic alloc + dirAdd, ALWAYS available: it mints via `mint()`, which already
		// defaults to `crypto.randomUUID()`, so gating the cap's installation on a
		// caller-supplied `mintIno` only ever meant "a bare memStorage() is quietly not
		// atomic". `mintIno` customises inode IDENTITY; it was never about atomicity.
		//
		// `content` is staged HERE, inside the claim, not by the VFS beforehand (#323):
		// hashing is the only await, and everything after it is synchronous, so the blob
		// and the inode referencing it become visible in the same turn. A `gcUnreferenced()`
		// sweep can never observe the blob without its reference.
		async atomicCreate(dirIno, name, meta, content, options) {
			const key = dirKey(dirIno, name)
			if (dirs.has(key)) throw new Error(`EEXIST: ${name}`)
			let stored = meta
			let blob: [string, Uint8Array] | undefined
			if (content !== undefined) {
				const hash = await sha256Hex(content)
				// Re-checked after that await — the one window here. A claim lost in it must
				// leave nothing staged, so nothing is written until the name is definitely ours.
				if (dirs.has(key)) throw new Error(`EEXIST: ${name}`)
				stored = { ...meta, size: BigInt(content.length), contentHash: hash }
				blob = [hash, content.slice()]
			}
			const ino = mint()
			if (blob) hashBlobs.set(blob[0], blob[1])
			metas.set(ino, { ...stored })
			dirs.set(key, { ino, type: stored.type })
			parentOf.set(ino, { parent: dirIno, name })
			const dirPath = pathOf(dirIno)
			const path = dirPath === null ? undefined : joinPath(dirPath, name)
			emit({ ino, kind: 'meta', source: options?.origin })
			emit({ ino, kind: 'dirent', dirIno, name, path, source: options?.origin })
			await observer?.record(
				treePort,
				{ kind: 'link', dirIno, name, ino, type: stored.type },
				options
			)
			return ino
		},

		// Atomic rename — moves a name (and its whole subtree) in one step, and
		// announces it as ONE effect however big the subtree is. What that costs to
		// record is the observer's call, not this backend's.
		async atomicMove(oldDir, oldName, newDir, newName, options) {
			const oldKey = dirKey(oldDir, oldName)
			const src = dirs.get(oldKey)
			if (!src) throw new Error(`ENOENT: ${oldName}`)
			const oldDirPath = pathOf(oldDir)
			const newDirPath = pathOf(newDir)
			if (oldDirPath === null || newDirPath === null) throw new Error('ENOENT: parent')
			const oldBase = joinPath(oldDirPath, oldName)
			const newBase = joinPath(newDirPath, newName)
			const newKey = dirKey(newDir, newName)
			const displaced = dirs.get(newKey) ?? null
			dirs.delete(oldKey)
			parentOf.delete(src.ino)
			dirs.set(newKey, src)
			parentOf.set(src.ino, { parent: newDir, name: newName })
			// Free the displaced inode (the new put at `newBase` supersedes it).
			if (displaced && displaced.ino !== src.ino && !hasDirentReference(displaced.ino)) {
				metas.delete(displaced.ino)
				xattrs.delete(displaced.ino)
				parentOf.delete(displaced.ino)
			}
			const displacedIno = displaced && displaced.ino !== src.ino ? displaced.ino : null
			await observer?.record(
				treePort,
				{
					kind: 'move',
					fromDirIno: oldDir,
					fromName: oldName,
					toDirIno: newDir,
					toName: newName,
					ino: src.ino,
					displaced: displacedIno
				},
				options
			)
			emit({
				ino: src.ino,
				kind: 'dirent',
				dirIno: newDir,
				name: newName,
				path: newBase,
				source: options?.origin
			})
			emit({
				ino: src.ino,
				kind: 'dirent',
				dirIno: oldDir,
				name: oldName,
				path: oldBase,
				source: options?.origin
			})
			return displacedIno
		},

		content: {
			async getByHash(hash) {
				return hashBlobs.get(hash)?.slice() ?? null
			},
			async hasByHash(hash) {
				return hashBlobs.has(hash)
			},
			async putByHash(hash, data) {
				hashBlobs.set(hash, data.slice())
			},
			// The in-memory sweep has no separate maintenance phase.
			async gcUnreferenced() {
				const live = new Set<string>()
				for (const m of metas.values()) if (m.contentHash) live.add(m.contentHash)
				let reclaimed = 0
				for (const hash of [...hashBlobs.keys()])
					if (!live.has(hash)) {
						hashBlobs.delete(hash)
						reclaimed++
					}
				// An in-memory prune has no budget to run out of, so it always drains.
				return { reclaimed, done: true }
			}
		}
	} satisfies StorageCapabilities
	const caps = implemented

	const storage: Storage = {
		rootIno,
		caps,

		async getMeta(ino) {
			return metas.get(ino) ?? null
		},

		async setMeta(ino, patch, options) {
			const existing = metas.get(ino)
			if (existing) {
				metas.set(ino, { ...existing, ...patch })
				emit({ ino, kind: 'meta', source: options?.origin })
				await observer?.record(treePort, { kind: 'meta', ino }, options)
				return
			}
			if (patch.type === undefined) return
			const now = 0n
			const full: InodeMeta = {
				type: patch.type,
				size: patch.size ?? 0n,
				mode: patch.mode ?? defaultMode(patch.type),
				mtimeNs: patch.mtimeNs ?? now,
				ctimeNs: patch.ctimeNs ?? now,
				contentHash: patch.contentHash,
				symlinkTarget: patch.symlinkTarget
			}
			metas.set(ino, full)
			emit({ ino, kind: 'meta', source: options?.origin })
		},

		async deleteInode(ino) {
			if (hasDirentReference(ino)) return
			metas.delete(ino)
			// Content is hash-addressed and shared; leave the blob for GC (a hash with
			// no referencing path is a harmless orphan).
			xattrs.delete(ino)
			emit({ ino, kind: 'meta' })
		},

		async getBlob(ino) {
			const hash = metas.get(ino)?.contentHash
			if (!hash) return new Uint8Array()
			return hashBlobs.get(hash)?.slice() ?? new Uint8Array()
		},

		async putBlob(ino, data, options) {
			// Emit synchronously (before the async content hash) so several storage ops
			// in one turn coalesce into a single watch event. The signal is a
			// change-notification only; `putBlob` resolves after the store commits, and
			// its awaiting caller (writeFile) sees the new content/hash.
			// Fail before announcing anything if the inode has already gone.
			if (!metas.has(ino)) throw new Error(`ENOENT: ino ${ino}`)
			emit({ ino, kind: 'content', source: options?.origin })
			const hash = await sha256Hex(data)
			hashBlobs.set(hash, data.slice())
			// Re-read AFTER the hash: that await is a window, and this is the check that
			// matters because nothing separates it from the write below. Storing the content
			// of an inode that no longer exists would be an orphan blob and a lie to the
			// caller — a save that saved nothing reachable.
			const meta = metas.get(ino)
			if (!meta) throw new Error(`ENOENT: ino ${ino}`)
			// A write moves mtime and ctime (POSIX, and what the SQLite backend does),
			// stamped before the effect is announced so the new time ships with it.
			const stamp = BigInt(Date.now()) * 1_000_000n
			metas.set(ino, {
				...meta,
				contentHash: hash,
				size: BigInt(data.length),
				mtimeNs: stamp,
				ctimeNs: stamp
			})
			await observer?.record(treePort, { kind: 'content', ino, contentHash: hash }, options)
		},

		async getDirent(dirIno, name) {
			return dirs.get(dirKey(dirIno, name)) ?? null
		},

		async putDirent(dirIno, name, entry, options) {
			dirs.set(dirKey(dirIno, name), entry)
			parentOf.set(entry.ino, { parent: dirIno, name })
			const dirPath = pathOf(dirIno)
			emit({
				ino: entry.ino,
				kind: 'dirent',
				dirIno,
				name,
				path: dirPath === null ? undefined : joinPath(dirPath, name),
				source: options?.origin
			})
			await observer?.record(
				treePort,
				{ kind: 'link', dirIno, name, ino: entry.ino, type: entry.type },
				options
			)
		},

		async deleteDirent(dirIno, name, options) {
			const existing = dirs.get(dirKey(dirIno, name))
			const dirPath = pathOf(dirIno)
			dirs.delete(dirKey(dirIno, name))
			if (existing) {
				if (parentOf.get(existing.ino)?.parent === dirIno) parentOf.delete(existing.ino)
				emit({
					ino: existing.ino,
					kind: 'dirent',
					dirIno,
					name,
					path: dirPath === null ? undefined : joinPath(dirPath, name),
					source: options?.origin
				})
				await observer?.record(
					treePort,
					{ kind: 'unlink', dirIno, name, ino: existing.ino },
					options
				)
			}
		},

		async listDirents(dirIno, cursor) {
			const prefix = `${dirIno}\0`
			const entries: { name: string; ino: Ino; type: FileType }[] = []
			for (const [key, entry] of dirs) {
				if (!key.startsWith(prefix)) continue
				const name = key.slice(prefix.length)
				if (cursor === '' || name > cursor) {
					entries.push({ name, ino: entry.ino, type: entry.type })
				}
			}
			return { entries, next: '' }
		}
	}

	return Object.assign(storage, opts?.extension?.attach(treePort)) as Storage & Attached
}
