/**
 * The server half of the one pass: the old SQLite tables → a `Store`.
 *
 * Not a `.sql` migration, though it reads like one. A row's xattrs live in one
 * JSON column of base64, its 64-bit fields as decimal TEXT, and SQLite has no
 * base64 — so the encoding `store.sqlite` reads back can only be written from
 * TypeScript. Going through the `Store` seam instead of `INSERT`ing into its
 * tables buys the rest: the seam assigns the feed positions, and rule 3 makes a
 * row the store already holds a no-op, which is the whole of this pass being
 * idempotent and resumable.
 *
 * It writes into whatever `Store` it is handed. In production that is
 * `sqliteStore(db)` over the very database being read — the old tables and the
 * new one live side by side until a later migration drops the old.
 */

import { type Legacy, migrate } from '@justfiles/fs/migrate'
import type { Hash, Store } from '@justfiles/fs/store'
import type { FileType } from '@justfiles/fs/types'
import type { DbAdapter } from './db'

/** Local-only in the old model: it never crossed the wire, so it must not survive. */
const LOCAL_XATTR = 'trusted.sync.'

/** `fs_contents.storage_kind`: the bytes are in the row, or they are in R2. */
const STORAGE_INLINE = 1

/**
 * As much of R2 as this pass needs. The old server put anything it could not
 * inline into a bucket, so without one every binary file migrates as a stub.
 */
type BlobReader = { get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> }

/**
 * One directory's live entries: the dirent that names each inode, the inode
 * itself, and the sync row that gave it the identity every replica shares.
 * `local_ino` is UNIQUE and NULL on a tombstone, so the join adds at most one
 * row and never resurrects a deleted one.
 */
const ENTRIES = `SELECT d.name AS name, d.ino AS ino,
		i.type AS type, i.mode AS mode, i.size AS size, i.mtime_ns AS mtime_ns,
		i.content_hash AS content_hash, i.symlink_target AS symlink_target,
		s.sync_id AS sync_id, s.revision AS revision
	FROM fs_dirents d
	JOIN fs_inodes i ON i.ino = d.ino
	LEFT JOIN fs_sync_nodes s ON s.local_ino = d.ino
	WHERE d.dir_ino = ?
	ORDER BY d.name`

/** Every xattr of every entry in one directory, in one read. */
const XATTRS = `SELECT x.ino AS ino, x.name AS name, x.value AS value
	FROM fs_xattrs x
	JOIN fs_dirents d ON d.ino = x.ino
	WHERE d.dir_ino = ?`

const toNumber = (value: unknown): number =>
	typeof value === 'number' ? value : Number(value as number | bigint | string)

const toBigInt = (value: unknown): bigint =>
	typeof value === 'bigint' ? value : BigInt(String(value))

const text = (value: unknown): string | null => (value == null ? null : String(value))

/** A BLOB comes back as a `Uint8Array` from node:sqlite and an `ArrayBuffer` from the DO. */
const bytes = (value: unknown): Uint8Array =>
	value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value as ArrayBuffer)

/**
 * Copy the old tables into `into`. `blobs` is the bucket the old server offloaded
 * to; without it, content it never inlined migrates as a row naming bytes this
 * store does not hold — which the seam allows, and which a read through
 * `hydratingBlobs` can still fetch from a peer that has them.
 *
 * `mounts` is `migrate`'s: a root-level name whose subtree belongs in another
 * store — `/private` on this side, into the DO's own local store bound there, so
 * the credentials it holds are not in the table clients pull.
 */
export async function migrateSqlite(
	db: DbAdapter,
	into: Store,
	opts?: { blobs?: BlobReader; mounts?: Map<string, Store> }
): Promise<void> {
	const blobs = opts?.blobs
	await migrate(
		{
			async entries(dir) {
				const xattrs = new Map<string, Record<string, Uint8Array>>()
				for (const row of await db.query(XATTRS, [dir])) {
					const name = String(row.name)
					if (name.startsWith(LOCAL_XATTR)) continue
					const ino = String(row.ino)
					const attrs = xattrs.get(ino) ?? {}
					attrs[name] = bytes(row.value)
					xattrs.set(ino, attrs)
				}
				return (await db.query(ENTRIES, [dir])).map((row): Legacy => {
					const ino = String(row.ino)
					return {
						ino,
						id: text(row.sync_id) ?? ino,
						name: String(row.name),
						type: toNumber(row.type) as FileType,
						mode: toNumber(row.mode),
						mtimeNs: toBigInt(row.mtime_ns),
						size: toBigInt(row.size),
						revision: row.revision == null ? 0 : toNumber(row.revision),
						contentHash: text(row.content_hash),
						symlinkTarget: text(row.symlink_target),
						xattrs: xattrs.get(ino) ?? {}
					}
				})
			},
			blob: (hash) => readBlob(db, hash, blobs)
		},
		into,
		opts?.mounts
	)
}

async function readBlob(
	db: DbAdapter,
	hash: Hash,
	blobs: BlobReader | undefined
): Promise<Uint8Array | null> {
	const [row] = await db.query(
		'SELECT storage_kind, inline_bytes, r2_key FROM fs_contents WHERE content_hash = ? LIMIT 1',
		[hash]
	)
	if (!row) return null
	if (toNumber(row.storage_kind) === STORAGE_INLINE)
		return row.inline_bytes == null ? null : bytes(row.inline_bytes)
	const key = text(row.r2_key)
	if (key === null || !blobs) return null
	const object = await blobs.get(key)
	return object === null ? null : new Uint8Array(await object.arrayBuffer())
}
