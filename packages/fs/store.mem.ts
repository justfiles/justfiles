import { type Guard, type Hash, type Node, type NodeId, ROOT, type Store } from './store'

/** Entries per `children` page. Big enough to be one page for a normal directory. */
const PAGE = 128

/** NUL — the one byte a name can never hold, so composed keys never collide. */
const SEP = String.fromCharCode(0)

const dirKey = (parent: NodeId, name: string): string => parent + SEP + name

/** The listing order, and the `children` cursor: name first, id to break a tie. */
const listKey = (n: Node): string => n.name + SEP + n.id

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
		if (old) byName.get(dirKey(old.parent, old.name))?.delete(old.id)
		byId.set(row.id, row)
		if (!row.deleted) {
			const key = dirKey(row.parent, row.name)
			const bucket = byName.get(key) ?? new Set<NodeId>()
			byName.set(key, bucket)
			bucket.add(row.id)
		}
		order.set(row.id, next++)
	}

	return {
		async get(id) {
			return byId.get(id) ?? null
		},

		async child(parent, name) {
			return lookup(parent, name)
		},

		async children(parent, cursor) {
			const live = [...byId.values()]
				.filter((n) => n.parent === parent && !n.deleted && n.id !== ROOT)
				.sort((a, b) => (listKey(a) < listKey(b) ? -1 : 1))
			const from = cursor ? live.findIndex((n) => listKey(n) > cursor) : 0
			if (from < 0) return { nodes: [] } // the cursor sits past the last entry
			const nodes = live.slice(from, from + PAGE)
			const last = nodes[nodes.length - 1]
			if (last && from + nodes.length < live.length) return { nodes, next: listKey(last) }
			return { nodes }
		},

		async since(cursor) {
			const from = cursor ? Number(cursor) : 0
			const nodes: Node[] = []
			for (const [id, at] of [...order].sort((a, b) => a[1] - b[1])) {
				const n = byId.get(id)
				if (at >= from && n) nodes.push(n)
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
