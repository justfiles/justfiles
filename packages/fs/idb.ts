/**
 * The IndexedDB `Store` — the design's one structural risk, discharged.
 *
 * IDB gives exactly one tool for an atomic guarded batch: a transaction that
 * lives only while IDB requests keep it alive. `await` anything else inside one
 * and it commits early, splitting the batch in two. That is why the seam is
 * `commit(writes, guards)` and not a `tx(fn)` closure — everything async
 * (hashing, opening the database) happens BEFORE the transaction opens, and
 * inside it there is nothing but IDB reads and IDB writes.
 *
 * The schema is the model, unchanged: one object store for nodes with two
 * indexes, one for blobs. Both indexes are derived from the row, so replacing a
 * row moves its own index entries — there is no second table to keep in step.
 */

import { type DBSchema, type IDBPDatabase, openDB } from 'idb'
import {
	type Cursor,
	ForeignCursorError,
	forwarded,
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

const DB_VERSION = 1

type Row = Node & {
	/** The one order (rule 4). Assigned inside the commit that writes the row. */
	seq: number
	/**
	 * `(parent, name)`, on live rows only. An IDB index skips a record whose key
	 * path is undefined, so a tombstone leaves the lookup by simply not carrying
	 * this field — no delete, no second table.
	 */
	live?: [NodeId, string]
}

interface Schema extends DBSchema {
	nodes: { key: NodeId; value: Row; indexes: { live: [NodeId, string]; seq: number } }
	blobs: { key: Hash; value: { hash: Hash; data: Uint8Array } }
	/** One durable value: the lineage (rule 11). It is not a node, so it is not a row. */
	meta: { key: string; value: string }
}

const encode = (node: Node, seq: number): Row =>
	// Root is nobody's child — it is its own parent — so it stays out of the
	// lookup, or a listing of a directory would contain that directory.
	node.deleted || node.id === ROOT
		? { ...node, seq }
		: { ...node, seq, live: [node.parent, node.name] }

const decode = ({ seq: _seq, live: _live, ...node }: Row): Node => node

const ROOT_ROW: Node = {
	id: ROOT,
	parent: ROOT, // root is its own parent; upward walks stop here
	name: '',
	type: 'dir',
	mode: 0o040755,
	mtimeNs: 0n,
	size: 0n,
	version: '0'
}

type Opened = { db: IDBPDatabase<Schema>; lineage: string }

/** The browser `Store`. One database per name; reopening one is not a reset. */
export function idbStore(name: string): Store {
	let opening: Promise<Opened> | null = null

	const start = async (): Promise<Opened> => {
		const db = await openDB<Schema>(name, DB_VERSION, {
			upgrade(db) {
				const nodes = db.createObjectStore('nodes', { keyPath: 'id' })
				nodes.createIndex('live', 'live')
				nodes.createIndex('seq', 'seq')
				db.createObjectStore('blobs', { keyPath: 'hash' })
				db.createObjectStore('meta')
			}
		})
		// Bootstrap, and only on a database that has neither: the root row (rule 6)
		// and the lineage (rule 11). A reopen finds both and keeps them, so a page
		// reload does not fence the replica's own cursors.
		const tx = db.transaction(['nodes', 'meta'], 'readwrite')
		const found = await tx.objectStore('meta').get('lineage')
		const lineage = found ?? crypto.randomUUID()
		if (!found) await tx.objectStore('meta').put(lineage, 'lineage')
		if (!(await tx.objectStore('nodes').getKey(ROOT)))
			await tx.objectStore('nodes').put(encode(ROOT_ROW, 0))
		await tx.done
		return { db, lineage }
	}

	const open = (): Promise<Opened> => (opening ??= start())

	const position = (cursor: Cursor | undefined, lineage: string): number => {
		if (cursor === undefined) return 0
		if (!cursor.startsWith(lineage + SEP)) throw new ForeignCursorError()
		return Number(cursor.slice(lineage.length + SEP.length))
	}

	return {
		async get(id) {
			const { db } = await open()
			const row = await db.get('nodes', id)
			return row ? decode(row) : null
		},

		async child(parent, name) {
			const { db } = await open()
			// Index records that share a key are ordered by primary key, so the
			// first one back holds the lowest id — rule 1's winner, without ever
			// reading the losers.
			const row = await db.getFromIndex('nodes', 'live', [parent, name])
			return row ? decode(row) : null
		},

		async children(parent, cursor) {
			const { db } = await open()
			// Every array key sorts after every string one, so `[]` is an upper
			// bound over every name without naming a character. The lower bound is
			// open on the cursor, which drops the whole name it stopped at —
			// including its duplicates.
			const range = IDBKeyRange.bound(
				[parent, cursor ?? ''],
				[parent, []],
				cursor !== undefined,
				false
			)
			const rows = await db.getAllFromIndex('nodes', 'live', range, PAGE + 1)

			const nodes: Node[] = []
			let last = cursor
			let more = rows.length > PAGE // there is at least one record past this page
			for (const row of rows) {
				if (row.name === last) continue // rule 1: one row per name, and the lowest id came first
				if (nodes.length === PAGE) {
					more = true
					break
				}
				nodes.push(decode(row))
				last = row.name
			}
			return more && last !== undefined ? { nodes, next: last } : { nodes }
		},

		/**
		 * Rule 4: each row once per scan, at its latest state, tombstones
		 * included. The `seq` index IS the order, so the scan is one ranged read
		 * and nothing is journaled behind it.
		 */
		async since(cursor) {
			const { db, lineage } = await open()
			const from = position(cursor, lineage)
			const rows = await db.getAllFromIndex('nodes', 'seq', IDBKeyRange.lowerBound(from), PAGE + 1)
			const page = rows.slice(0, PAGE)
			const overflow = rows[PAGE]
			const last = page[page.length - 1]
			// Always a cursor back: a full page resumes AT the row that did not
			// fit, and a short one resumes past the last row it carried.
			const next = overflow ? overflow.seq : last ? last.seq + 1 : from
			return { nodes: page.map(decode), next: lineage + SEP + next }
		},

		/**
		 * The kill criterion. One transaction: every guard, then every write, with
		 * no `await` of anything but IDB between them — a guard evaluated in a
		 * transaction the writes do not share is a race, not a guard.
		 */
		async commit(writes, guards) {
			// Taken before the first `await`, which is where the caller gets control
			// back and may edit a row it just handed over. What the guards see and
			// what lands has to be the batch as it stood at the call — `memStore`
			// never awaits at all, so anything else makes the two backends disagree.
			const batch = structuredClone(writes)
			const checks = structuredClone(guards)

			const { db } = await open()
			const tx = db.transaction('nodes', 'readwrite')
			const nodes = tx.objectStore('nodes')
			try {
				// Rule 2: every guard before any write, so a failure writes nothing.
				for (const guard of checks ?? []) {
					const pass =
						'free' in guard
							? (await nodes.index('live').getKey([guard.free.parent, guard.free.name])) ===
								undefined
							: ((await nodes.get(guard.version.id))?.version ?? null) === guard.version.is
					if (!pass) throw new GuardError(guard)
				}

				// The next position, read here rather than counted in memory: another
				// tab commits into this same database, and two rows sharing a seq
				// would let a resumed cursor step over one of them.
				const end = await nodes.index('seq').openCursor(null, 'prev')
				let seq = (end ? end.key : -1) + 1

				for (const write of batch) {
					const old = await nodes.get(write.id)
					if (old && same(old, write)) continue // rule 3: a row the store already holds is a no-op
					await nodes.put(encode(write, seq++))
				}
				// The commit resolves on the TRANSACTION, not on its last request: a
				// browser may still take the transaction away — storage pressure, a
				// closed tab — and a caller told the batch landed would never retry it.
				await tx.done
			} catch (error) {
				// Abort, and from the ONE place every failure passes through. A failed
				// guard is a deliberate one, but a `put` that THROWS instead of failing
				// a request — an uncloneable value, a key the store cannot extract —
				// leaves IDB with no request to fail, so it would commit the writes
				// before it while this call reports failure.
				try {
					tx.abort()
				} catch {
					// Already finished or already aborting: this failure is that one.
				}
				// The transaction's own rejection is this same failure. Claim it, or it
				// surfaces a second time as an unhandled one.
				await tx.done.catch(() => {})
				throw error
			}
		},

		/**
		 * The connection this store opened, and nothing else. Whoever CONSTRUCTED the
		 * store calls it; a store nobody ever opened has nothing to release, so this
		 * does not open one just to close it.
		 *
		 * It is what makes a database deletable: `indexedDB.deleteDatabase` waits on
		 * every open connection and fires `onblocked` instead of completing, so a
		 * "forget this browser" that could not close its own handle would leave the
		 * data it promised to delete sitting on disk.
		 */
		async close() {
			if (opening) (await opening).db.close()
		},

		// No `subscribe`. Rule 8 makes it optional — a latency optimization over
		// polling `since` — and a consumer takes it INSTEAD of polling whenever a
		// store offers one. This backend cannot honour that: the DATABASE is the
		// store, not the connection (a cursor one connection mints still means what
		// it meant to the next), so a wake held in one connection's closure would
		// never fire for a second tab's commit and a watcher would go permanently
		// stale rather than merely late. Polling `since` sees every connection's
		// commits. The cross-tab wake is additive and lives beside the commit
		// instead: `sharedStore` below.

		// Rule 7: content-keyed and immutable, so a hash the map already holds is
		// already the answer and the second put is nothing. IDB hands every reader
		// its own copy, so nothing here can reach into stored content.
		blobs: {
			async has(hash) {
				const { db } = await open()
				return (await db.getKey('blobs', hash)) !== undefined
			},
			async get(hash) {
				const { db } = await open()
				return (await db.get('blobs', hash))?.data ?? null
			},
			async put(hash, data) {
				// Held before the first `await`: the caller may edit its array the
				// moment this call returns to it, and what lands must be what it
				// handed over.
				const held = new Uint8Array(data)
				const { db } = await open()
				const tx = db.transaction('blobs', 'readwrite')
				if ((await tx.store.getKey(hash)) === undefined) await tx.store.put({ hash, data: held })
				await tx.done
			}
		}
	}
}

/**
 * The wake this backend cannot promise, over the one bus that can keep it.
 *
 * A `BroadcastChannel` reaches every tab of the origin, so a subscriber over one is
 * complete in exactly the way a connection-local closure is not — which is the whole of
 * `idbStore`'s objection to offering `subscribe` itself. With it, `volume`'s watch
 * stops polling and a local write arms its push at once instead of waiting out the
 * interval.
 *
 * A wrapper rather than something `idbStore` does for itself, because a wake is a
 * latency decision and the store is not where it is measured. It is here rather than in
 * a host because there are two browser hosts and one browser: `BroadcastChannel` is
 * available exactly where `indexedDB` is.
 *
 * `channel` must be scoped the way the database is — the database's own name is the
 * obvious choice, since two stores over one name are two connections to one store.
 */
export function sharedStore(store: Store, channel: string): Store {
	const bus = new BroadcastChannel(channel)
	const listeners = new Set<(writes: Node[]) => void>()
	const tell = (writes: Node[]) => {
		for (const fn of listeners) fn(writes)
	}
	bus.onmessage = (event) => tell(event.data as Node[])
	return {
		...forwarded(store),
		async commit(writes, guards) {
			await store.commit(writes, guards)
			if (writes.length === 0) return
			tell(writes)
			// Rows, not a bare wake: a watcher decides from what changed, and a tab that
			// had to re-scan to find out would pay for every other tab's writes.
			bus.postMessage(writes)
		},
		subscribe(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		async close() {
			bus.close()
			await store.close?.()
		}
	}
}

/**
 * Ask the browser to keep this origin's storage, and report whether it will.
 *
 * Without this, everything a volume holds is "best-effort": the browser may
 * evict it under storage pressure, and Safari deletes script-written storage
 * after seven days of browser use with no interaction on the site. Eviction is
 * ALL-OR-NOTHING per origin — IndexedDB and the Cache API go together — so for
 * a local-first app with no external copy, it is silent and total
 * data loss rather than a cold cache.
 *
 * What it is worth differs by browser, and none of it is a guarantee. Firefox
 * prompts. Chrome and Safari decide silently from engagement, so a first visit
 * is usually refused and a later one may not be — which is why this asks again
 * on every call rather than remembering a refusal. Safari's seven-day cap has
 * no documented exemption other than installing to the home screen, so this
 * complements a web app manifest rather than replacing one.
 *
 * `false` is an answer, not a failure. A host that promises local-first should
 * treat it as a reason to offer an external copy or export, not swallow it.
 */
export async function persistStorage(): Promise<boolean> {
	const storage = globalThis.navigator?.storage
	if (!storage?.persist) return false
	try {
		// Asking again when it has already been granted would re-prompt on Firefox.
		return (await storage.persisted()) || (await storage.persist())
	} catch {
		return false
	}
}
