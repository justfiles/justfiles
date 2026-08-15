import { type Guard, type Hash, type Node, type NodeId, ROOT, type Store } from './store'

/** Entries per `children` page. Big enough to be one page for a normal directory. */
const PAGE = 128

/** NUL — the one byte a name can never hold, so composed keys never collide. */
const SEP = String.fromCharCode(0)

const dirKey = (parent: NodeId, name: string): string => parent + SEP + name

/** Rows cross the boundary by value, exactly as a durable or wire-backed store does. */
const copy = (n: Node): Node => structuredClone(n)

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((byte, i) => byte === b[i])

const sameXattrs = (a: Node['xattrs'], b: Node['xattrs']): boolean => {
	const keys = Object.keys(a ?? {})
	if (keys.length !== Object.keys(b ?? {}).length) return false
	return keys.every((k) => {
		const x = a?.[k]
		const y = b?.[k]
		return x !== undefined && y !== undefined && sameBytes(x, y)
	})
}

/** Rule 3: idempotent by content. Whole rows, so every field counts. Ids match by lookup. */
const same = (a: Node, b: Node): boolean =>
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

/**
 * The reference `Store`: two maps (by id, by `(parent, name)`) plus the local
 * order. Everything else in the design is derived from these.
 *
 * `since` and `blobs` are the minimum the interface needs; their contract rules
 * (4, 5, 11 and 7, 10) belong to T2 and T3.
 */
export function memStore(): Store {
	const byId = new Map<NodeId, Node>()
	const byName = new Map<string, Set<NodeId>>() // live rows only
	const order = new Map<NodeId, number>() // id -> its latest position in the local order
	const content = new Map<Hash, Uint8Array>()
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

	const put = (row: Node): void => {
		const old = byId.get(row.id)
		if (old && same(old, row)) return // rule 3: a row the store already holds is a no-op
		const held = copy(row)
		if (old) byName.get(dirKey(old.parent, old.name))?.delete(old.id)
		byId.set(held.id, held)
		if (!held.deleted) {
			const key = dirKey(held.parent, held.name)
			const bucket = byName.get(key) ?? new Set<NodeId>()
			byName.set(key, bucket)
			bucket.add(held.id)
		}
		order.set(held.id, next++)
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

		async since(cursor) {
			const from = cursor ? Number(cursor) : 0
			const nodes: Node[] = []
			for (const [id, at] of [...order].sort((a, b) => a[1] - b[1])) {
				const n = byId.get(id)
				if (at >= from && n) nodes.push(copy(n))
			}
			return { nodes, next: String(next) }
		},

		/** Rule 2: every guard is checked before any write, so a failure writes nothing. */
		async commit(writes, guards) {
			for (const guard of guards ?? [])
				if (!pass(guard)) throw new Error(`commit rejected: guard ${JSON.stringify(guard)} failed`)
			for (const row of writes) put(row)
		},

		blobs: {
			async has(hash) {
				return content.has(hash)
			},
			async get(hash) {
				return content.get(hash) ?? null
			},
			async put(hash, data) {
				content.set(hash, data)
			}
		}
	}
}
