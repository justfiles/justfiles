/**
 * The client half of the one pass: an old-model IndexedDB database → a `Store`.
 *
 * Copy-then-swap, not an in-place version upgrade. The old database is opened
 * READ-ONLY and never altered, and the rows land in a different database — so a
 * pass that is interrupted has broken nothing, re-running it costs a re-read and
 * writes only what did not land, and the host swaps which name it opens once the
 * copy is complete. An in-place upgrade would have to be atomic across a schema
 * that shares no shape with the new one, and would leave a half-converted
 * database with nothing to roll back to.
 *
 * It reads the old schema directly rather than through `storage.idb` — the two
 * sync stores it also reads (`syncNodes`) belong to a package `packages/fs`
 * cannot import, and the old vocabulary has no place in new code. Only the five
 * object stores the pass needs are declared.
 */

import { type DBSchema, openDB } from 'idb'
import { type Legacy, migrate } from './migrate'
import type { Store } from './store'
import type { FileType } from './types'

/** Local-only in the old model: it never crossed the wire, so it must not survive. */
const LOCAL_XATTR = 'trusted.sync.'

/**
 * As much of the two old schemas as the pass reads, and no more. `packages/fs`
 * owned `inodes`/`dirs`/`xattrs`/`content`; `packages/sync` added `syncNodes`
 * beside them, holding the identity every replica shared.
 */
interface Old extends DBSchema {
	inodes: {
		key: string
		value: {
			ino: string
			type: FileType
			size: bigint
			mode: number
			mtimeNs: bigint
			contentHash?: string
			symlinkTarget?: string
		}
	}
	dirs: {
		key: [string, string]
		value: { dirIno: string; name: string; ino: string }
		indexes: { 'by-dir': string }
	}
	xattrs: {
		key: [string, string]
		value: { ino: string; name: string; value: Uint8Array }
		indexes: { 'by-ino': string }
	}
	content: { key: string; value: { contentHash: string; data: Uint8Array } }
	syncNodes: {
		key: string
		value: { id: string; localIno: string | null; revision: number }
		indexes: { 'by-local-ino': string }
	}
}

/**
 * Copy one old database into `into`. `from` is a database NAME — `store.idb`
 * takes one too, and the two must differ, which is the whole of the swap.
 *
 * `mounts` is `migrate`'s: a root-level name whose subtree belongs in another
 * store — `/private` on this side, into the browser-local store bound there.
 */
export async function migrateIdb(
	from: string,
	into: Store,
	mounts?: Map<string, Store>
): Promise<void> {
	// No version, so this opens whatever is there and never triggers an upgrade:
	// the old database must come out of this pass exactly as it went in.
	const db = await openDB<Old>(from)
	try {
		// Nothing of the old model here — a name that was never an old database, or
		// one this pass already swapped away from. Either way there is nothing to do.
		if (!db.objectStoreNames.contains('inodes')) return
		// A client that never had the sync extension attached: every node is
		// local-only, and its ino is the identity it will keep.
		const shared = db.objectStoreNames.contains('syncNodes')

		await migrate(
			{
				async entries(dir) {
					const out: Legacy[] = []
					for (const dirent of await db.getAllFromIndex('dirs', 'by-dir', dir)) {
						const inode = await db.get('inodes', dirent.ino)
						// A dirent whose inode is gone names nothing. The old model let one
						// exist transiently; the new one has no way to spell it.
						if (!inode) continue
						const node = shared
							? await db.getFromIndex('syncNodes', 'by-local-ino', dirent.ino)
							: undefined
						const xattrs: Record<string, Uint8Array> = {}
						for (const attr of await db.getAllFromIndex('xattrs', 'by-ino', dirent.ino))
							if (!attr.name.startsWith(LOCAL_XATTR)) xattrs[attr.name] = attr.value
						out.push({
							ino: dirent.ino,
							id: node?.id ?? dirent.ino,
							name: dirent.name,
							type: inode.type,
							mode: inode.mode,
							mtimeNs: inode.mtimeNs,
							size: inode.size,
							revision: node?.revision ?? 0,
							contentHash: inode.contentHash ?? null,
							symlinkTarget: inode.symlinkTarget ?? null,
							xattrs
						})
					}
					return out
				},
				async blob(hash) {
					// The old content store was LRU-evicted, so a hash with no bytes behind
					// it is ordinary, not a fault.
					return (await db.get('content', hash))?.data ?? null
				}
			},
			into,
			mounts
		)
	} finally {
		db.close()
	}
}
