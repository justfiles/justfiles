import type { InodeMeta, Storage, StorageCapabilities, StorageChange } from './storage'
import type { PathStorePort } from './storage.shared'
import {
	applyJournaledOver,
	joinPath,
	journalDeleteOver,
	journalPutOver,
	localChangeOver,
	sortChildFirst,
	sortParentFirst
} from './storage.shared'
import type { JournalRow } from './sync-replica'
import type { PathChange } from './sync-wire'
import { coalesceByPath, inodeMetaFromSync } from './sync-wire'
import type { DirentMin, Ino } from './types'
import { FileType } from './types'

/**
 * `mintIno` lets a caller control inode identity — e.g. a numeric-ino backend
 * (like real OS inodes) vs a UUID one — so heterogeneous ino spaces can be
 * exercised. When provided, an `atomicCreate` cap mints via it; otherwise the
 * VFS mints its own UUIDs. Root is always `'1'`. `localActorId` is the backend's
 * client-id, stamped as the ORIGIN (`PathChange.source`) on local mutations.
 */
export function memStorage(opts?: { mintIno?: () => Ino; localActorId?: string }): Storage {
	const metas = new Map<Ino, InodeMeta>()
	// Content is hash-addressed (matching R2): the inode holds a `contentHash` ref,
	// the bytes live here keyed by that hash. Dedupes and lets pulled content be
	// materialised out-of-band by the SyncReplica's BlobStore.
	const hashBlobs = new Map<string, Uint8Array>()
	const dirs = new Map<string, DirentMin>() // key: `${dirIno}\0${name}`
	const xattrs = new Map<Ino, Map<string, Uint8Array>>()
	const rootIno = '1'
	const mintIno = opts?.mintIno
	const localActorId = opts?.localActorId ?? 'local'
	// Reverse index child ino -> { parent, name } (one dirent per ino; hard links
	// unsupported). Powers O(depth) `pathOf(ino)` for in-transaction path stamping.
	const parentOf = new Map<Ino, { parent: Ino; name: string }>()
	// The per-path scalar version generator (outgoing versions) + tombstones. This
	// is the backend's generator, distinct from the engine's PathSyncState baseline.
	const pathVersion = new Map<string, number>()
	const tombstone = new Map<string, number>()

	// Path journal (write-intercept): an append-only, path-stamped, seq-ordered log.
	// Shared by the `caps.journal` primitive, the per-mutation stamping, and
	// `caps.pathApply.applyJournaled`. `seq` is this backend's SyncCursor.
	const journalRows: JournalRow[] = []
	let journalSeq = 0
	function appendJournal(changes: PathChange[], localSource?: string): void {
		for (const change of changes) {
			journalSeq += 1
			journalRows.push({ seq: journalSeq, change, localSource })
		}
	}

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

	/** User-xattr snapshot for an inode (base64/`trusted.sync.*` handling in wire). */
	function xattrRecord(ino: Ino): Record<string, Uint8Array> {
		const m = xattrs.get(ino)
		if (!m) return {}
		return Object.fromEntries(m)
	}

	// ── Path-sync port (the storage-independent seam for the shared apply driver) ─
	// mem is synchronous + atomic (single-threaded JS), so there is no transaction
	// and emits fire inline. The shared driver (storage.shared.ts) owns the
	// orchestration; this port is just the minimal per-backend primitives.
	const pathPort: PathStorePort = {
		mintIno: mint,
		async resolveIno(path) {
			return resolveIno(path)
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
		async upsertInodeFromSync(ino, change) {
			if (change.kind !== 'put') return
			const { meta, xattrs: snapshot } = inodeMetaFromSync(change.meta)
			const type = meta.type ?? FileType.Regular
			metas.set(ino, {
				type,
				size: meta.size ?? 0n,
				mode: meta.mode ?? defaultMode(type),
				mtimeNs: meta.mtimeNs ?? 0n,
				ctimeNs: 0n, // ctime is set locally at apply time, never wired
				contentHash: change.contentHash,
				symlinkTarget: meta.symlinkTarget
			})
			// Replace the whole USER-xattr set with the snapshot; keep trusted.sync.*.
			const existing = xattrs.get(ino)
			if (existing)
				for (const k of [...existing.keys()]) if (!k.startsWith('trusted.sync.')) existing.delete(k)
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
		async readPathVersion(path) {
			return { version: pathVersion.get(path) ?? 0, tombstone: tombstone.get(path) ?? 0 }
		},
		async setPathVersion(path, version, tomb) {
			pathVersion.set(path, version)
			tombstone.set(path, tomb)
		},
		async appendJournalRow(change, localSource) {
			appendJournal([change], localSource)
		},
		emit
	}

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

	const caps: StorageCapabilities = {
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

		// Atomic alloc + dirAdd using the caller-supplied minter. Only present when
		// `mintIno` is set; otherwise the VFS mints UUIDs via setMeta + putDirent.
		// `content` (see storage.ts) is never passed: this backend has a hash-addressed
		// content store, so the claim carries a `meta.contentHash` reference instead.
		...(mintIno
			? {
					async atomicCreate(dirIno, name, meta, _content, options) {
						const key = dirKey(dirIno, name)
						if (dirs.has(key)) throw new Error(`EEXIST: ${name}`)
						const ino = mintIno()
						metas.set(ino, { ...meta })
						dirs.set(key, { ino, type: meta.type })
						parentOf.set(ino, { parent: dirIno, name })
						const dirPath = pathOf(dirIno)
						const path = dirPath === null ? undefined : joinPath(dirPath, name)
						emit({ ino, kind: 'meta', source: options?.source })
						emit({ ino, kind: 'dirent', dirIno, name, path, source: options?.source })
						// Regular files are journaled by the following putBlob (once hashed).
						if (dirPath)
							await journalPutOver(pathPort, joinPath(dirPath, name), ino, localActorId, options)
						return ino
					}
				}
			: {}),

		// Atomic rename — moves a name (and its whole subtree) in one step. Journals
		// the move as an ordered subtree delete+put: deletes child-before-parent (never
		// orphan a live child under a deleted dir), then puts parent-before-child.
		async atomicMove(oldDir, oldName, newDir, newName, options) {
			const oldKey = dirKey(oldDir, oldName)
			const src = dirs.get(oldKey)
			if (!src) throw new Error(`ENOENT: ${oldName}`)
			const oldDirPath = pathOf(oldDir)
			const newDirPath = pathOf(newDir)
			if (oldDirPath === null || newDirPath === null) throw new Error('ENOENT: parent')
			const oldBase = joinPath(oldDirPath, oldName)
			const newBase = joinPath(newDirPath, newName)
			// Enumerate BEFORE mutating (paths are prefix-rewritten, children keep their
			// parent-ino-keyed dirents — only the top entry rebinds).
			const subtree = enumerateSubtree(src.ino)
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
			// Journal the move as ordered subtree changes: deletes child-before-parent
			// (never orphan a live child under a deleted dir), then puts parent-before-
			// child (the dir exists before its entries) — ordering shared with apply.
			const deletePaths = sortChildFirst(
				subtree.map((n) => oldBase + n.rel),
				(p) => p
			)
			for (const p of deletePaths) await journalDeleteOver(pathPort, p, localActorId, options)
			const putNodes = sortParentFirst(subtree, (n) => newBase + n.rel)
			for (const n of putNodes)
				await journalPutOver(pathPort, newBase + n.rel, n.ino, localActorId, options)
			emit({
				ino: src.ino,
				kind: 'dirent',
				dirIno: newDir,
				name: newName,
				path: newBase,
				source: options?.source
			})
			emit({
				ino: src.ino,
				kind: 'dirent',
				dirIno: oldDir,
				name: oldName,
				path: oldBase,
				source: options?.source
			})
			return displaced && displaced.ino !== src.ino ? displaced.ino : null
		},

		// ── Path-sync seams ──────────────────────────────────────────────────────
		async clearSyncState() {
			pathVersion.clear()
			tombstone.clear()
			journalRows.length = 0
			journalSeq = 0
		},
		journal: {
			async append(changes, localSource) {
				appendJournal(changes, localSource)
			},
			async readFrom(seq, limit) {
				return journalRows.filter((r) => r.seq > seq).slice(0, limit)
			},
			async head() {
				return journalRows[journalRows.length - 1]?.seq ?? 0
			},
			async adoptAllAsLocal(opts) {
				const current = coalesceByPath(journalRows.map((row) => row.change)).filter(
					(change) => !opts?.dropDeletes || change.kind === 'put'
				)
				journalRows.length = 0
				appendJournal(current)
			}
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
			async gcUnreferenced() {
				const latest = new Map(journalRows.map((row) => [row.change.path, row]))
				journalRows.splice(
					0,
					journalRows.length,
					...[...latest.values()].sort((a, b) => a.seq - b.seq)
				)
				const live = new Set<string>()
				for (const m of metas.values()) if (m.contentHash) live.add(m.contentHash)
				let count = 0
				for (const hash of [...hashBlobs.keys()])
					if (!live.has(hash)) {
						hashBlobs.delete(hash)
						count++
					}
				return count
			}
		},
		pathApply: {
			async localChange(path) {
				return localChangeOver(pathPort, path, localActorId)
			},
			async applyJournaled(changes, opts) {
				await applyJournaledOver(pathPort, changes, opts)
			}
		}
	}

	return {
		rootIno,
		caps,

		async getMeta(ino) {
			return metas.get(ino) ?? null
		},

		async setMeta(ino, patch, options) {
			const existing = metas.get(ino)
			if (existing) {
				metas.set(ino, { ...existing, ...patch })
				emit({ ino, kind: 'meta', source: options?.source })
				// A linked inode's metadata changed (chmod/utimes/…) — journal it. An
				// unlinked inode (createNode's setMeta before putDirent) has no path yet.
				const path = pathOf(ino)
				if (path) await journalPutOver(pathPort, path, ino, localActorId, options)
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
			emit({ ino, kind: 'meta', source: options?.source })
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
			emit({ ino, kind: 'content', source: options?.source })
			const hash = await sha256Hex(data)
			hashBlobs.set(hash, data.slice())
			// Re-read AFTER the hash: that await is a window, and this is the check that
			// matters because nothing separates it from the write below. Storing the content
			// of an inode that no longer exists would be an orphan blob and a lie to the
			// caller — a save that saved nothing reachable.
			const meta = metas.get(ino)
			if (!meta) throw new Error(`ENOENT: ino ${ino}`)
			{
				// A write moves mtime and ctime (POSIX, and what the SQLite backend does),
				// stamped before the journal row is built so the new time ships with it.
				const stamp = BigInt(Date.now()) * 1_000_000n
				metas.set(ino, {
					...meta,
					contentHash: hash,
					size: BigInt(data.length),
					mtimeNs: stamp,
					ctimeNs: stamp
				})
				const path = pathOf(ino)
				if (path) await journalPutOver(pathPort, path, ino, localActorId, options)
			}
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
				source: options?.source
			})
			// Non-regular puts journal here; regular files wait for putBlob (once hashed).
			if (dirPath)
				await journalPutOver(pathPort, joinPath(dirPath, name), entry.ino, localActorId, options)
		},

		async deleteDirent(dirIno, name, options) {
			const existing = dirs.get(dirKey(dirIno, name))
			// Resolve the path BEFORE unlinking so the delete is stamped correctly.
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
					source: options?.source
				})
				if (dirPath)
					await journalDeleteOver(pathPort, joinPath(dirPath, name), localActorId, options)
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
}
