/**
 * The old model's tree, as a description — and the IndexedDB half of writing one.
 *
 * The stack that used to produce these fixtures is gone, so the tests state the
 * shape the pass reads instead of driving the code that wrote it. That is the
 * honest way round anyway: `migrate.idb.ts` declares the five object stores it
 * reads and nothing else, and this writes exactly those, so the fixture and the
 * pass agree about the schema in one place instead of two.
 *
 * `LegacyNode` is deliberately backend-neutral, because the claim that decides
 * whether the pass may ship is about TWO backends: a client and a server holding
 * the same tree under the same shared sync ids and each holding its OWN local
 * inodes. `migrate.sqlite.test.ts` writes the same description into the old SQL
 * tables and compares the rows both passes produce.
 *
 * Test support for a migration that still ships. It leaves when `migrate.*` does.
 */

import { openDB } from 'idb'
import { sha256Hex } from './store'
import { FileType } from './types'

/** The old root, on every backend that ever ran that schema. */
export const LEGACY_ROOT = '1'

/** One node of an old tree, as the two old halves between them described it. */
export type LegacyNode = {
	/** The old inode number. Per-replica: two backends holding one tree disagree here. */
	ino: string
	/** The SHARED sync id, where the replica had one. Absent means the node never synced. */
	id?: string
	/** The parent's ino, in THIS backend's numbering. `LEGACY_ROOT` for a root entry. */
	parent: string
	name: string
	type: FileType
	/** Permission bits. The kind comes from `type`. */
	mode: number
	/** Regular files only. */
	content?: Uint8Array
	/** Symlinks only. */
	target?: string
	xattrs?: Record<string, Uint8Array>
	/** The sync node's revision. Ignored where there is no `id`. */
	revision?: number
}

/** Fixed, because a per-replica stamp is exactly what two converged replicas must not differ in. */
export const LEGACY_MTIME_NS = 1_700_000_000_000_000_000n

/**
 * Write one old-model IndexedDB database. `syncNodes` is created only when some
 * node carries a shared id — its ABSENCE is what tells the pass "this client never
 * had the sync extension attached", which is a case worth being able to build.
 */
export async function writeLegacyIdb(name: string, nodes: LegacyNode[]): Promise<void> {
	const shared = nodes.some((node) => node.id !== undefined)
	const db = await openDB(name, 1, {
		upgrade(db) {
			db.createObjectStore('inodes', { keyPath: 'ino' })
			db.createObjectStore('content', { keyPath: 'contentHash' })
			db.createObjectStore('dirs', { keyPath: ['dirIno', 'name'] }).createIndex('by-dir', 'dirIno')
			db.createObjectStore('xattrs', { keyPath: ['ino', 'name'] }).createIndex('by-ino', 'ino')
			if (shared)
				db.createObjectStore('syncNodes', { keyPath: 'id' }).createIndex('by-local-ino', 'localIno')
		}
	})
	try {
		for (const node of nodes) {
			const contentHash = node.content ? await sha256Hex(node.content) : undefined
			if (node.content && contentHash) await db.put('content', { contentHash, data: node.content })
			await db.put('inodes', {
				ino: node.ino,
				type: node.type,
				size: BigInt(node.content?.byteLength ?? 0),
				mode: node.mode,
				mtimeNs: LEGACY_MTIME_NS,
				ctimeNs: LEGACY_MTIME_NS,
				contentHash,
				symlinkTarget: node.target
			})
			await db.put('dirs', { dirIno: node.parent, name: node.name, ino: node.ino })
			for (const [attr, value] of Object.entries(node.xattrs ?? {}))
				await db.put('xattrs', { ino: node.ino, name: attr, value })
			if (shared && node.id !== undefined)
				await db.put('syncNodes', {
					id: node.id,
					localIno: node.ino,
					revision: node.revision ?? 0
				})
		}
	} finally {
		db.close()
	}
}

/** A directory, for a fixture that only cares that one is there. */
export const dir = (ino: string, parent: string, name: string, mode = 0o755): LegacyNode => ({
	ino,
	parent,
	name,
	type: FileType.Directory,
	mode
})

/** A regular file with bytes in it. */
export const file = (
	ino: string,
	parent: string,
	name: string,
	content: Uint8Array
): LegacyNode => ({ ino, parent, name, type: FileType.Regular, mode: 0o644, content })

/** A symlink. `target` is the old model's stored string, unresolved. */
export const symlink = (ino: string, parent: string, name: string, target: string): LegacyNode => ({
	ino,
	parent,
	name,
	type: FileType.Symlink,
	mode: 0o777,
	target
})
