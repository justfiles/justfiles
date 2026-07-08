import type {
	InodeMeta,
	MutationOptions,
	Storage,
	StorageCapabilities,
	StorageChange
} from './storage'
import {
	buildDeleteChange,
	buildPutChange,
	joinPath,
	nextVersion,
	sortChildFirst,
	sortParentFirst,
	splitPath
} from './storage.shared'
import type { JournalRow } from './sync-replica'
import type { PathChange } from './sync-wire'
import { inodeMetaFromSync } from './sync-wire'
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

	/** Split a canonical absolute path into { parentPath, name }. */
	const parentAndName = splitPath

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

	// ── Local-mutation journaling (write-intercept, path-stamped) ────────────────
	// Every mutation through the public Storage primitives appends a path-stamped
	// journal row via the shared pure builders, with a version from the shared
	// generator and ORIGIN = options.source ?? localActorId (localSource stays
	// undefined — that tag is set only by the remote apply seam). Feeds `pathDeltas`.

	/** Journal a `put` for a linked path from the inode's current state. */
	function journalPut(path: string, ino: Ino, options?: MutationOptions): void {
		const meta = metas.get(ino)
		if (!meta) return
		const version = nextVersion(pathVersion.get(path) ?? 0, tombstone.get(path) ?? 0)
		const change = buildPutChange(
			path,
			meta,
			xattrRecord(ino),
			version,
			options?.source ?? localActorId
		)
		// null = a fresh regular file with no content yet; putBlob will journal it.
		// Only consume the version when we actually journal.
		if (!change) return
		pathVersion.set(path, version)
		appendJournal([change])
	}

	/** Journal a `delete` for a path and record its tombstone version. */
	function journalDelete(path: string, options?: MutationOptions): void {
		const version = nextVersion(pathVersion.get(path) ?? 0, tombstone.get(path) ?? 0)
		pathVersion.set(path, version)
		tombstone.set(path, Math.max(tombstone.get(path) ?? 0, version))
		appendJournal([buildDeleteChange(path, version, options?.source ?? localActorId)])
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
		...(mintIno
			? {
					async atomicCreate(dirIno, name, meta, options) {
						const key = dirKey(dirIno, name)
						if (dirs.has(key)) throw new Error(`EEXIST: ${name}`)
						const ino = mintIno()
						metas.set(ino, { ...meta })
						dirs.set(key, { ino, type: meta.type })
						parentOf.set(ino, { parent: dirIno, name })
						emit({ ino, kind: 'meta', source: options?.source })
						emit({ ino, kind: 'dirent', dirIno, name, source: options?.source })
						// Regular files are journaled by the following putBlob (once hashed).
						const dirPath = pathOf(dirIno)
						if (dirPath) journalPut(joinPath(dirPath, name), ino, options)
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
			for (const p of deletePaths) journalDelete(p, options)
			const putNodes = sortParentFirst(subtree, (n) => newBase + n.rel)
			for (const n of putNodes) journalPut(newBase + n.rel, n.ino, options)
			emit({ ino: src.ino, kind: 'dirent', dirIno: newDir, name: newName, source: options?.source })
			emit({ ino: src.ino, kind: 'dirent', dirIno: oldDir, name: oldName, source: options?.source })
			return displaced && displaced.ino !== src.ino ? displaced.ino : null
		},

		// ── Path-sync seams (Phase 0: shape only) ────────────────────────────────
		journal: {
			async append(changes, localSource) {
				appendJournal(changes, localSource)
			},
			async readFrom(seq, limit) {
				return journalRows.filter((r) => r.seq > seq).slice(0, limit)
			},
			async head() {
				return journalRows[journalRows.length - 1]?.seq ?? 0
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
			}
		},
		pathApply: {
			async applyJournaled(changes, opts) {
				// Remote-authored apply: install tree metadata + contentHash REFERENCE
				// (blob bytes are materialised out-of-band by applyPathChanges), journal
				// the change VERBATIM (its version + origin source) plus localSource, and
				// fast-forward path_version (never lower it). NEVER writes blob bytes.
				for (const change of changes) {
					const p = change.path
					if (change.kind === 'put') {
						const { parentPath, name } = parentAndName(p)
						const parentIno = ensureDir(parentPath)
						const key = dirKey(parentIno, name)
						const ino = dirs.get(key)?.ino ?? mint()
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
						dirs.set(key, { ino, type })
						parentOf.set(ino, { parent: parentIno, name })
						// Replace the whole USER-xattr set with the snapshot; keep local-only
						// trusted.sync.* untouched.
						const existing = xattrs.get(ino)
						if (existing)
							for (const k of [...existing.keys()])
								if (!k.startsWith('trusted.sync.')) existing.delete(k)
						if (Object.keys(snapshot).length > 0) {
							let m = xattrs.get(ino)
							if (!m) {
								m = new Map()
								xattrs.set(ino, m)
							}
							for (const [k, v] of Object.entries(snapshot)) m.set(k, v)
						}
						// Emit so volume caches invalidate and volume.watch fires on the pull
						// (tagged with localSource for echo suppression) — applyJournaled
						// writes the maps directly, so it must signal the change feed itself.
						emit({ ino, kind: 'meta', source: opts.localSource })
						emit({ ino, kind: 'dirent', dirIno: parentIno, name, source: opts.localSource })
						if (type === FileType.Regular) emit({ ino, kind: 'content', source: opts.localSource })
					} else {
						const ino = resolveIno(p)
						const { parentPath, name } = parentAndName(p)
						const parentIno = resolveIno(parentPath)
						if (parentIno) dirs.delete(dirKey(parentIno, name))
						if (ino) {
							parentOf.delete(ino)
							if (!hasDirentReference(ino)) {
								metas.delete(ino)
								xattrs.delete(ino)
							}
						}
						if (ino !== null && parentIno !== null)
							emit({ ino, kind: 'dirent', dirIno: parentIno, name, source: opts.localSource })
						if (ino !== null) emit({ ino, kind: 'meta', source: opts.localSource })
						tombstone.set(p, Math.max(tombstone.get(p) ?? 0, Number(change.version)))
					}
					pathVersion.set(p, Math.max(pathVersion.get(p) ?? 0, Number(change.version)))
					appendJournal([change], opts.localSource)
				}
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
				if (path) journalPut(path, ino, options)
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
			emit({ ino, kind: 'content', source: options?.source })
			const hash = await sha256Hex(data)
			hashBlobs.set(hash, data.slice())
			const meta = metas.get(ino)
			if (meta) {
				metas.set(ino, { ...meta, contentHash: hash, size: BigInt(data.length) })
				const path = pathOf(ino)
				if (path) journalPut(path, ino, options)
			}
		},

		async getDirent(dirIno, name) {
			return dirs.get(dirKey(dirIno, name)) ?? null
		},

		async putDirent(dirIno, name, entry, options) {
			dirs.set(dirKey(dirIno, name), entry)
			parentOf.set(entry.ino, { parent: dirIno, name })
			emit({ ino: entry.ino, kind: 'dirent', dirIno, name, source: options?.source })
			// Non-regular puts journal here; regular files wait for putBlob (once hashed).
			const dirPath = pathOf(dirIno)
			if (dirPath) journalPut(joinPath(dirPath, name), entry.ino, options)
		},

		async deleteDirent(dirIno, name, options) {
			const existing = dirs.get(dirKey(dirIno, name))
			// Resolve the path BEFORE unlinking so the delete is stamped correctly.
			const dirPath = pathOf(dirIno)
			dirs.delete(dirKey(dirIno, name))
			if (existing) {
				if (parentOf.get(existing.ino)?.parent === dirIno) parentOf.delete(existing.ino)
				emit({ ino: existing.ino, kind: 'dirent', dirIno, name, source: options?.source })
				if (dirPath) journalDelete(joinPath(dirPath, name), options)
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
