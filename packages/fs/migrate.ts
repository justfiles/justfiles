/**
 * One pass: the old twin model's data → `Node` rows. Ids survive.
 *
 * The old model kept the same tree twice — a disk-FS half (inodes, dirents,
 * per-inode meta) and a sync half (sync ids, `parentId + name`, revisions) —
 * joined by a per-replica `ino ↔ syncId` mapping. This is that join, run once:
 * each inode is read with the dirent that named it, and written as one row.
 *
 * Two decisions carry the whole thing, and both are about what every replica
 * must agree on afterwards. A migrated client and a migrated server converge
 * with nothing on the wire only if their rows are IDENTICAL (rule 3), so both
 * sides derive every field of a row from data the old model already replicated:
 *
 * - **The id is the SYNC id, not the ino.** The design's note that "`id` can
 *   simply BE the existing ino" holds only for a replica that never synced: a
 *   node arriving from a peer is given a FRESH local ino (`applyMutation` in the
 *   old `packages/sync/node.ts` mints one), so the ino is per-replica and the
 *   sync id is the shared identity. Where a node has no sync row — local-only
 *   data, or a tree written before sync was attached — the ino stands in, which
 *   is safe because both are UUIDs. The old root, `'1'` on every backend, maps
 *   to `ROOT`.
 * - **The version is `migrated:<revision>`.** The revision is replicated, so
 *   both sides mint the same string and the first pull reads every row as a
 *   no-op. The author is `migrated`, which is no live replica, so the first push
 *   filters every row out and no user pays for a re-upload on the day this
 *   ships.
 *
 * The author is uniform, and that has a cost worth stating: a row the client had
 * written but NOT yet pushed is authored `migrated` like every other, so the
 * first push leaves it behind and the server's older row is what both sides
 * converge on. The old stack pushes continuously, so the window is a live
 * client's last few seconds — but an offline one can hold days of it. Closing it
 * needs the old push cursor out of `/.state/sync`, which is state this pass is
 * told to drop; `synced.ts`'s `takeMine` re-authors rows wholesale and is the
 * other way to spend it. Neither is decided here.
 *
 * What is deliberately NOT carried:
 *
 * - **Tombstones.** A tombstone exists to tell a peer about a delete, and after
 *   this pass every peer already knows: both sides drop them, so both sides hold
 *   the same rows. The walk gives this for free — a deleted node has no dirent.
 * - **Journal rows, snapshot sessions, `/.state`.** All of it is old-engine
 *   bookkeeping. The new engine keeps its position in a `CursorSlot` the host
 *   owns, outside the replicated table and outside the user's tree.
 * - **`trusted.sync.*` xattrs.** Local-only in the old model — they never
 *   crossed the wire, so carrying them would make two converged replicas differ.
 * - **The root row.** Every store seeds its own, identical on both sides. The
 *   old root's mode and mtime are per-replica (nothing replicated them), so
 *   carrying them is exactly how to make two migrated replicas disagree.
 *
 * The pass is resumable and idempotent by construction, with nothing to
 * checkpoint: blobs are content-keyed, and rule 3 makes a row the store already
 * holds a no-op. Re-running it after a crash costs a re-read and writes only
 * what did not land.
 */

import { type Hash, type Node, type NodeId, ROOT, type Store } from './store'
import { FileType } from './types'

/** Rows per commit. One transaction per batch, so a huge tree is many small ones. */
const BATCH = 256

/** Where the walk starts: the old root, on every backend that ever ran that schema. */
const ROOT_INO = '1'

/**
 * The old engine's private tree. Dropped whole: `/.state/sync` is the old
 * cursors and `/.state/clientid` the old device id, and neither has a reader
 * left. It is a ROOT-level name, so a `.state` deeper in the tree is user data
 * and survives.
 *
 * `/private`, the OTHER never-replicated prefix of the old model, is NOT dropped
 * and is NOT the same problem. It holds real user data — credentials, caches —
 * that the old engine kept local by FILTERING the path, and this model has no
 * path filter: the store model replaced that with a mount. So a `/private` migrated into a REPLICATED store stops being local, and
 * that is what `mounts` is for: a root-level name in it takes its whole subtree
 * into another store, hanging off that store's own root, and the host announces a
 * `mount` row in its place. Both halves belong to the host, because only the host
 * knows its local store.
 */
const STATE = '.state'

/**
 * What an old `FileType` becomes. Two fields, because the old model stated the
 * kind twice over — once in `FileType` and never in `mode` — and a row states it
 * once, in a whole POSIX mode with the S_IFMT bits on it.
 */
const KIND: Record<FileType, { type: Node['type']; ifmt: number }> = {
	[FileType.Regular]: { type: 'file', ifmt: 0o100000 },
	[FileType.Directory]: { type: 'dir', ifmt: 0o040000 },
	[FileType.Symlink]: { type: 'symlink', ifmt: 0o120000 }
}

/** One old inode, joined with the dirent that named it and the sync row that shared it. */
export type Legacy = {
	/** The old inode number. How the walk descends, and the id when nothing shared one. */
	ino: string
	/** The shared identity: the sync node id where the replica had one, else the ino. */
	id: NodeId
	name: string
	type: FileType
	/** Permission bits. The kind comes from `type`. */
	mode: number
	mtimeNs: bigint
	size: bigint
	/** The sync node's revision, or 0. What makes the version identical on every replica. */
	revision: number
	contentHash: string | null
	symlinkTarget: string | null
	/** User xattrs only — `trusted.sync.*` never crossed the wire and is dropped. */
	xattrs: Record<string, Uint8Array>
}

/**
 * What a backend must hand the pass: its tree, one directory at a time, and its
 * bytes by hash. Two methods, because everything else about the two old
 * backends — an IDB index versus a SQL join — is theirs and not this file's.
 */
export type LegacyTree = {
	/** The live entries of one directory. Order is irrelevant; the walk imposes its own. */
	entries(dir: string): Promise<Legacy[]>
	/** The bytes for a hash, or `null` where the backend no longer holds them. */
	blob(hash: Hash): Promise<Uint8Array | null>
}

/**
 * Walk the old tree down from its root and write it as rows.
 *
 * Down, not in any order the backend finds convenient, for two reasons. It is
 * the join — a dirent is what gives an inode its parent and its name, and an
 * inode no dirent names is unreachable and therefore already gone. And it puts
 * every parent in an earlier batch than its children, so a pass interrupted
 * halfway leaves a smaller tree rather than a broken one.
 *
 * Bytes land before the row that names them (rule 10): a crash then leaves an
 * orphan blob, which is garbage, instead of a row whose content was never
 * stored, which is a hole.
 *
 * `mounts` maps a ROOT-LEVEL name to the store its subtree belongs in — the
 * local data the old model kept off the wire with a path filter. Its rows land
 * under that store's own root and are never written here at all, so no page, no
 * tombstone and no blob request in the synced store can name one.
 */
export async function migrate(
	from: LegacyTree,
	into: Store,
	mounts?: Map<string, Store>
): Promise<void> {
	const queue: Array<{ ino: string; id: NodeId; into: Store }> = [{ ino: ROOT_INO, id: ROOT, into }]
	const batches = new Map<Store, Node[]>()
	const flush = async (): Promise<void> => {
		for (const [store, rows] of batches) if (rows.length > 0) await store.commit(rows)
		batches.clear()
	}

	for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
		const store = dir.into
		for (const entry of await from.entries(dir.ino)) {
			// The root of the store this pass was HANDED is the one place a name can be a
			// mount point: a bound store's own root is `ROOT` too, so the store is what
			// tells the two apart.
			if (store === into && dir.id === ROOT) {
				if (entry.name === STATE) continue
				const bound = mounts?.get(entry.name)
				if (bound !== undefined) {
					// Everything under this name goes into the bound store, hanging off ITS
					// root: what was `/private/x` is `x` there. The name in THIS store
					// becomes a mount row, which `announceMount` writes and this pass does
					// not — a derived row needs no data out of the old model, and writing
					// one here would put the old directory's per-replica ino on it.
					queue.push({ ino: entry.ino, id: ROOT, into: bound })
					continue
				}
			}
			const node = row(entry, dir.id)
			if (node.content !== undefined && !(await store.blobs.has(node.content))) {
				// A hash the backend cannot produce — evicted from the client's LRU,
				// swept on the server — travels as a stub, which the seam allows and a
				// read through `hydratingBlobs` fetches from the peer. Failing here
				// would let one missing blob stop the whole tree from migrating.
				const data = await from.blob(node.content)
				if (data !== null) await store.blobs.put(node.content, data)
			}
			const batch = batches.get(store) ?? []
			batch.push(node)
			batches.set(store, batch)
			if (entry.type === FileType.Directory)
				queue.push({ ino: entry.ino, id: node.id, into: store })
			if (batch.length >= BATCH) await flush()
		}
	}
	await flush()
}

/** The row a legacy entry becomes, under the parent it was found in. */
const row = (entry: Legacy, parent: NodeId): Node => {
	const kind = KIND[entry.type]
	const node: Node = {
		id: entry.id,
		parent,
		name: entry.name,
		type: kind.type,
		mode: kind.ifmt | (entry.mode & 0o7777),
		mtimeNs: entry.mtimeNs,
		size: entry.size,
		version: `migrated:${entry.revision}`
	}
	// Absent stays absent rather than becoming an `undefined` key: `same` compares
	// whole rows, and a row that reads back differently is a row that syncs.
	if (entry.contentHash !== null) node.content = entry.contentHash
	if (entry.symlinkTarget !== null) node.link = entry.symlinkTarget
	if (Object.keys(entry.xattrs).length > 0) node.xattrs = entry.xattrs
	return node
}
