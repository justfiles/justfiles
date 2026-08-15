/**
 * The seam. One table, two indexes, one order, one guarded atomic write, one
 * blob map. It is both the storage API and the wire: a remote peer is just
 * another `Store`.
 *
 * Types are copied from `kb/fs/fable-design.md` #2 and #3. The 11 contract
 * rules live in #3 under "Contract"; the conformance suite cites them by
 * number.
 */

export type NodeId = string // UUID. Minted once, never rebound. Root is a constant.
export type Hash = string // SHA-256 of content bytes, hex.
export type Version = string // Opaque to storage. The engine owns its meaning.
export type Cursor = string // Opaque, per replica. Never crosses the wire.

export type Node = {
	id: NodeId
	parent: NodeId
	name: string
	type: 'file' | 'dir' | 'symlink' | 'mount' // mount: a junction to another store
	mode: number
	mtimeNs: bigint
	size: bigint // denormalized so stat never touches content
	xattrs?: Record<string, Uint8Array> // small values only; big data belongs in content
	content?: Hash // files only
	link?: string // symlinks only, inline
	version: Version
	deleted?: true // tombstone: only id, version, deleted stay meaningful
}

export type Page = { nodes: Node[]; next?: Cursor }

export type Guard =
	| { free: { parent: NodeId; name: string } } // no live node holds this (parent, name)
	| { version: { id: NodeId; is: Version | null } } // CAS; null means "must not exist"

export interface Store {
	// The two indexes on the one table.
	get(id: NodeId): Promise<Node | null>
	child(parent: NodeId, name: string): Promise<Node | null>
	children(parent: NodeId, cursor?: Cursor): Promise<Page>

	// The one ordering. Always hands a cursor back — an empty page means caught
	// up — and rejects a cursor from another lineage with `ForeignCursorError`.
	since(cursor?: Cursor): Promise<Page>

	// The one write.
	commit(writes: Node[], guards?: Guard[]): Promise<void>

	// The one content map.
	blobs: {
		has(hash: Hash): Promise<boolean>
		get(hash: Hash): Promise<Uint8Array | null>
		put(hash: Hash, data: Uint8Array): Promise<void>
	}

	// Optional. Everything works without these.
	subscribe?(listener: (writes: Node[]) => void): () => void
	gc?(): Promise<{ reclaimed: number; done: boolean }>
}

/** The root directory id (contract rule 6). The same constant on every replica. */
export const ROOT: NodeId = '00000000-0000-0000-0000-000000000000'

/**
 * A cursor was minted by another lineage (contract rule 11), so no position in
 * this store answers to it. A reset or replaced store starts a new lineage;
 * this is how it fences a replica that outlived it. The caller restarts from
 * the empty cursor and converges.
 */
export class ForeignCursorError extends Error {
	constructor() {
		super('cursor belongs to another store lineage; scan again from the empty cursor')
		this.name = 'ForeignCursorError'
	}
}
