import type { InodeMeta, Storage, StorageCapabilities, StorageChange } from './storage'
import type { JournalRow } from './sync-replica'
import type { PathChange } from './sync-wire'
import { inodeMetaFromSync } from './sync-wire'
import type { DirentMin, Ino } from './types'
import { FileType } from './types'

/**
 * `mintIno` lets a caller control inode identity — e.g. a numeric-ino backend
 * (like real OS inodes) vs a UUID one — so heterogeneous ino spaces can be
 * exercised. When provided, an `atomicCreate` cap mints via it; otherwise the
 * VFS mints its own UUIDs. Root is always `'1'`.
 */
export function memStorage(opts?: { mintIno?: () => Ino }): Storage {
	const metas = new Map<Ino, InodeMeta>()
	// Content is hash-addressed (matching R2): the inode holds a `contentHash` ref,
	// the bytes live here keyed by that hash. Dedupes and lets pulled content be
	// materialised out-of-band by the SyncReplica's BlobStore.
	const hashBlobs = new Map<string, Uint8Array>()
	const dirs = new Map<string, DirentMin>() // key: `${dirIno}\0${name}`
	const xattrs = new Map<Ino, Map<string, Uint8Array>>()
	const rootIno = '1'
	const mintIno = opts?.mintIno

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
	function parentAndName(p: string): { parentPath: string; name: string } {
		const idx = p.lastIndexOf('/')
		return { parentPath: idx === 0 ? '/' : p.slice(0, idx), name: p.slice(idx + 1) }
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
			cur = ino
		}
		return cur
	}

	// The per-path scalar version generator (outgoing versions) + tombstones. This
	// is the backend's generator, distinct from the engine's PathSyncState baseline.
	const pathVersion = new Map<string, number>()
	const tombstone = new Map<string, number>()

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
						emit({ ino, kind: 'meta', source: options?.source })
						emit({ ino, kind: 'dirent', dirIno, name, source: options?.source })
						return ino
					}
				}
			: {}),

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
					} else {
						const ino = resolveIno(p)
						const { parentPath, name } = parentAndName(p)
						const parentIno = resolveIno(parentPath)
						if (parentIno) dirs.delete(dirKey(parentIno, name))
						if (ino && !hasDirentReference(ino)) {
							metas.delete(ino)
							xattrs.delete(ino)
						}
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
			if (meta) metas.set(ino, { ...meta, contentHash: hash, size: BigInt(data.length) })
		},

		async getDirent(dirIno, name) {
			return dirs.get(dirKey(dirIno, name)) ?? null
		},

		async putDirent(dirIno, name, entry, options) {
			dirs.set(dirKey(dirIno, name), entry)
			emit({ ino: entry.ino, kind: 'dirent', dirIno, name, source: options?.source })
		},

		async deleteDirent(dirIno, name, options) {
			const existing = dirs.get(dirKey(dirIno, name))
			dirs.delete(dirKey(dirIno, name))
			if (existing)
				emit({ ino: existing.ino, kind: 'dirent', dirIno, name, source: options?.source })
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
