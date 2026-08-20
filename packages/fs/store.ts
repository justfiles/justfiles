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
	// `type` and `mode` both state the kind of node, and `mount` is the one value
	// with no POSIX encoding. Which of the two should be derived from the other is
	// open — parked deliberately, not overlooked. Until it is settled, `mode` is a
	// whole POSIX mode and consumers take the kind from `type`.
	type: 'file' | 'dir' | 'symlink' | 'mount' // mount: a junction to another store
	mode: number // full POSIX mode: S_IFMT type bits and permission bits
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

	/**
	 * Release what THIS store owns — a watcher, a connection, a handle. Optional, because
	 * most stores own nothing: memory, a wire, a database somebody else opened.
	 *
	 * Called by whoever CONSTRUCTED the store, and by nobody else. A store is composable —
	 * two volumes at different scopes, an engine, an authority and a wire adapter may all
	 * hold the same one — and none of them may end it, which is why a wrapper owns none and
	 * forwards none (see `forwarded`). Idempotent: after it a caller is done with the store,
	 * and may not rely on whether it still answers.
	 */
	close?(): Promise<void>
}

/**
 * What a wrapper forwards: the seam, minus the one member it must not. Spreading a whole
 * store copies `close` like any other method, which would hand a caller of the WRAPPER a
 * way to end a store the wrapper never built.
 */
export const forwarded = (store: Store): Omit<Store, 'close'> => {
	const { close, ...rest } = store
	return rest
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

/**
 * A guard did not hold, so the commit wrote nothing (contract rule 2). Its own
 * type because a caller has to tell it from a store that is broken: a rejection
 * means "read again and replan" — which is how a write claims a name, how a
 * read-modify-write stays one, and how an authority refuses a conflict — while a
 * failure means the write may never land at all. Every backend throws this one.
 *
 * A reason stands in for the guard where an authority refuses a commit no
 * `Guard` could have stated — rule 9's tree invariants, in `authority.ts`. The
 * same type on purpose: to a caller it is the same event, and it is this one
 * type the engine's replan turns on.
 */
export class GuardError extends Error {
	/**
	 * Which guard did not hold, kept beside the message because a wire has to
	 * carry it: a 409 that only says "refused" would reach the other side as a
	 * message to parse rather than as the guard the caller stated.
	 */
	readonly reason: Guard | string

	constructor(reason: Guard | string) {
		super(
			typeof reason === 'string'
				? `commit rejected: ${reason}`
				: `commit rejected: guard ${JSON.stringify(reason)} failed`
		)
		this.name = 'GuardError'
		this.reason = reason
	}
}

/**
 * Contract rule 3: does the store already hold this row? Whole rows, so every
 * field counts — the id matches by lookup. Every backend needs the same answer,
 * or a retry that is a no-op on one store manufactures change-feed traffic on
 * another.
 */
export const same = (a: Node, b: Node): boolean =>
	a.parent === b.parent &&
	a.name === b.name &&
	a.type === b.type &&
	a.mode === b.mode &&
	a.mtimeNs === b.mtimeNs &&
	a.size === b.size &&
	a.content === b.content &&
	a.link === b.link &&
	a.version === b.version &&
	a.deleted === b.deleted &&
	sameXattrs(a.xattrs, b.xattrs)

const sameXattrs = (a: Node['xattrs'], b: Node['xattrs']): boolean => {
	const keys = Object.keys(a ?? {})
	if (keys.length !== Object.keys(b ?? {}).length) return false
	return keys.every((k) => {
		const x = a?.[k]
		const y = b?.[k]
		return (
			x !== undefined &&
			y !== undefined &&
			x.length === y.length &&
			x.every((byte, i) => byte === y[i])
		)
	})
}

/**
 * Bytes that do not hash to the key they were offered under (rule 7). Its own
 * type for the wire: the request contradicts itself, which is the CALLER's
 * mistake, and a peer told so as a client error can tell it from a store that
 * failed.
 */
export class HashMismatchError extends Error {
	constructor(hash: Hash) {
		super(`blob bytes do not hash to ${hash}`)
		this.name = 'HashMismatchError'
	}
}

/**
 * The untrusting half of contract rule 7: reject a `put` whose bytes do not
 * hash to its key. A local caller is trusted, so it skips this; a store that
 * takes writes from a peer wraps its own blob map in it. Admit one lie here
 * and the hash stops meaning the content everywhere.
 */
export const verifiedBlobs = (blobs: Store['blobs']): Store['blobs'] => ({
	has: (hash) => blobs.has(hash),
	get: (hash) => blobs.get(hash),
	async put(hash, data) {
		// One snapshot, hashed and then stored. The caller still owns `data` and
		// may edit it while the digest is in flight, and what is verified has to
		// be what lands — or the check proves nothing about the stored bytes.
		const held = new Uint8Array(data)
		if ((await sha256Hex(held)) !== hash) throw new HashMismatchError(hash)
		await blobs.put(hash, held)
	}
})

/** The one definition of what a `Hash` is: SHA-256 of the bytes, hex. */
export const sha256Hex = async (data: Uint8Array): Promise<Hash> => {
	// The cast: `digest` takes a buffer over a plain `ArrayBuffer`, and a plain
	// `Uint8Array` is over `ArrayBufferLike` — the shared-memory case it never sees
	// here. Spelled through `unknown` rather than through `BufferSource`, which is a
	// DOM name this package cannot assume its consumers' lib has.
	const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer)
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}
