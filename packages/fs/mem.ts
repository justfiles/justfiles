import {
	type Cursor,
	ForeignCursorError,
	type Guard,
	GuardError,
	type Hash,
	type Node,
	type NodeId,
	ROOT,
	type Store,
	same
} from './store'

/** Rows per page. Big enough to list a normal directory in one page. */
const PAGE = 128

/** NUL — the one byte a name can never hold, so composed keys never collide. */
const SEP = String.fromCharCode(0)

const dirKey = (parent: NodeId, name: string): string => parent + SEP + name

/** Rows cross the boundary by value, exactly as a durable or wire-backed store does. */
const copy = (n: Node): Node => structuredClone(n)

/**
 * The reference `Store`: two maps (by id, by `(parent, name)`) plus the local
 * order, and a third map for content. Everything else in the design is derived
 * from these.
 */
export function memStore(): Store {
	const byId = new Map<NodeId, Node>()
	const byName = new Map<string, Set<NodeId>>() // live rows only
	// The feed, and no journal behind it: one entry per row, holding its latest
	// position. A Map iterates in insertion order, so re-inserting a row on every
	// write both moves it to the end of the order and keeps the scan in order.
	const order = new Map<NodeId, number>()
	const content = new Map<Hash, Uint8Array>()
	const listeners = new Set<(writes: Node[]) => void>()
	/** Rule 11: cursors mean nothing outside the store instance that minted them. */
	const lineage = crypto.randomUUID()
	let next = 0

	byId.set(ROOT, {
		id: ROOT,
		parent: ROOT, // root is its own parent; upward walks stop here
		name: '',
		type: 'dir',
		mode: 0o040755,
		mtimeNs: 0n,
		size: 0n,
		version: '0'
	})
	order.set(ROOT, next++) // the feed is an index over the one table: no row is exempt

	/** Contract rule 1: two live rows for one name resolve to the lowest id. */
	const lookup = (parent: NodeId, name: string): Node | null => {
		let best: Node | null = null
		for (const id of byName.get(dirKey(parent, name)) ?? []) {
			const n = byId.get(id)
			if (n && (!best || n.id < best.id)) best = n
		}
		return best
	}

	const pass = (guard: Guard): boolean => {
		if ('free' in guard) return lookup(guard.free.parent, guard.free.name) === null
		return (byId.get(guard.version.id)?.version ?? null) === guard.version.is
	}

	/** The written row, or null when there was nothing to write. */
	const put = (row: Node): Node | null => {
		const old = byId.get(row.id)
		if (old && same(old, row)) return null // rule 3: a row the store already holds is a no-op
		const held = copy(row)
		if (old) byName.get(dirKey(old.parent, old.name))?.delete(old.id)
		byId.set(held.id, held)
		if (!held.deleted) {
			const key = dirKey(held.parent, held.name)
			const bucket = byName.get(key) ?? new Set<NodeId>()
			byName.set(key, bucket)
			bucket.add(held.id)
		}
		order.delete(held.id) // rule 4: re-inserting moves the row to the end of the order
		order.set(held.id, next++)
		return held
	}

	const mark = (at: number): Cursor => lineage + SEP + at

	const position = (cursor?: Cursor): number => {
		if (cursor === undefined) return 0
		if (!cursor.startsWith(lineage + SEP)) throw new ForeignCursorError()
		return Number(cursor.slice(lineage.length + SEP.length))
	}

	return {
		async get(id) {
			const n = byId.get(id)
			return n ? copy(n) : null
		},

		async child(parent, name) {
			const n = lookup(parent, name)
			return n ? copy(n) : null
		},

		async children(parent, cursor) {
			const sorted = [...byId.values()]
				.filter((n) => n.parent === parent && !n.deleted && n.id !== ROOT)
				.sort((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1))
			// One row per name: a duplicate sorts next to its winner, so skipping every row
			// whose name is not past the last one emitted drops the losers and resumes a
			// paged listing in the same step. That makes the cursor just a name.
			const nodes: Node[] = []
			let last = cursor
			let more = false
			for (const n of sorted) {
				if (last !== undefined && n.name <= last) continue
				if (nodes.length === PAGE) {
					more = true
					break
				}
				nodes.push(copy(n))
				last = n.name
			}
			return more && last !== undefined ? { nodes, next: last } : { nodes }
		},

		/**
		 * Rule 4: each row once per scan, at its latest state, tombstones included.
		 * A row written mid-scan moves past the cursor, so it comes round again
		 * instead of being missed — the reason the feed needs no journal to be
		 * resumable.
		 */
		async since(cursor) {
			const from = position(cursor)
			const nodes: Node[] = []
			for (const [id, at] of order) {
				if (at < from) continue
				if (nodes.length === PAGE) return { nodes, next: mark(at) }
				const row = byId.get(id)
				if (row) nodes.push(copy(row))
			}
			return { nodes, next: mark(next) }
		},

		/** Rule 2: every guard is checked before any write, so a failure writes nothing. */
		async commit(writes, guards) {
			for (const guard of guards ?? []) if (!pass(guard)) throw new GuardError(guard)
			const written = writes.map(put).filter((row) => row !== null)
			// Rule 8: after the commit, and only for what it changed. A listener is
			// a notification, never a step in the commit, so its failure stays its
			// own: it can neither fail a write that already landed nor starve the
			// listener behind it.
			if (written.length === 0) return
			for (const listener of listeners)
				try {
					listener(written.map(copy))
				} catch {
					// The listener owns its errors.
				}
		},

		subscribe(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},

		// Rule 7: content-keyed and immutable, so a hash the map already holds is
		// already the answer and the second put is nothing. The copies are what a
		// durable or wire-backed store does anyway: neither side can reach into
		// stored content through an array it kept.
		blobs: {
			async has(hash) {
				return content.has(hash)
			},
			async get(hash) {
				const data = content.get(hash)
				return data === undefined ? null : new Uint8Array(data)
			},
			async put(hash, data) {
				if (!content.has(hash)) content.set(hash, new Uint8Array(data))
			}
		}
	}
}
