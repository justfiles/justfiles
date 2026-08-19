/**
 * The authority's durable `Store`. One `nodes` table with the two lookups and
 * the one order as indexes over it, one `blobs` table, and one `meta` row for
 * the lineage — the same schema the model has on every other backend.
 *
 * It takes a `SyncDb` (`db.ts`), so the same code runs on `node:sqlite`
 * under vitest and on the Durable Object's SQLite in production. The whole of
 * `commit` — every guard and every write — is one `transactionSync`: a guard
 * evaluated in a transaction the writes do not share is a race, not a guard,
 * and a write that fails mid-batch must leave the rows before it out too
 * (rule 2). That second half is why the seam is synchronous: `transactionSync`
 * is the only genuinely atomic transaction a Durable Object has, and it needs a
 * synchronous body. Nothing here ever awaited anything but the database, so
 * that costs this store no capability.
 *
 * It lives in `packages/core` because it is server code; `packages/fs` stays
 * dependency-free.
 */

import {
	type Cursor,
	ForeignCursorError,
	type Guard,
	GuardError,
	type Node,
	type NodeId,
	ROOT,
	type Store,
	same
} from '@justfiles/fs/store'
import type { SqlValue, SyncDb } from './db'

/** Rows per page. Big enough to list a normal directory in one page. */
const PAGE = 128

/** NUL — the one byte a name can never hold, so composed keys never collide. */
const SEP = String.fromCharCode(0)

const COLUMNS =
	'id, parent, name, type, mode, mtime_ns, size, xattrs, content, link, version, deleted, seq'
const PLACEHOLDERS = COLUMNS.split(', ')
	.map(() => '?')
	.join(', ')

/**
 * The whole schema, and no more of one: the two lookups and the one order are
 * indexes over the single table, so there is nothing to keep in step with it.
 * No foreign key binds a row to its parent — rule 9 leaves tree invariants to
 * the authority's guards, and a replica may transiently hold detached rows.
 */
const schema = (t: Tables): string[] => [
	`CREATE TABLE IF NOT EXISTS ${t.nodes} (
		id TEXT PRIMARY KEY,
		parent TEXT NOT NULL,
		name TEXT NOT NULL COLLATE BINARY,
		type TEXT NOT NULL,
		mode INTEGER NOT NULL,
		-- The two 64-bit fields, as decimal TEXT rather than INTEGER. The Durable
		-- Object hands every column back as ArrayBuffer, string, number or null --
		-- SqlStorageValue has no bigint -- and an epoch nanosecond stamp is far
		-- past 2^53, so an INTEGER column would come back rounded: get would stop
		-- returning the row that was committed, and rule 3 would read every
		-- re-commit of it as a change. Nothing sorts or compares on either one.
		mtime_ns TEXT NOT NULL,
		size TEXT NOT NULL,
		xattrs TEXT,
		content TEXT,
		link TEXT,
		version TEXT NOT NULL,
		deleted INTEGER NOT NULL DEFAULT 0,
		-- INTEGER, because this one IS compared and taken the MAX of in SQL. It
		-- counts row writes, so it stays a JS number for the life of the store.
		seq INTEGER NOT NULL
	)`,
	// Live rows only, so a tombstone leaves the lookup by being written — no
	// delete, no second table. Not UNIQUE: rule 1 admits two live rows for one
	// name mid-sync and resolves them by the lowest id, and `id` is the last
	// index column so that winner is the first record read.
	`CREATE INDEX IF NOT EXISTS ${t.nodes}_live ON ${t.nodes}(parent, name, id) WHERE deleted = 0`,
	`CREATE INDEX IF NOT EXISTS ${t.nodes}_seq ON ${t.nodes}(seq)`,
	`CREATE TABLE IF NOT EXISTS ${t.blobs} (hash TEXT PRIMARY KEY, data BLOB NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS ${t.meta} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
]

/** Rule 3: a write replaces the WHOLE row, so every column comes from the new one. */
const replace = (t: Tables): string => `INSERT INTO ${t.nodes}(${COLUMNS}) VALUES (${PLACEHOLDERS})
	ON CONFLICT(id) DO UPDATE SET
		parent = excluded.parent, name = excluded.name, type = excluded.type,
		mode = excluded.mode, mtime_ns = excluded.mtime_ns, size = excluded.size,
		xattrs = excluded.xattrs, content = excluded.content, link = excluded.link,
		version = excluded.version, deleted = excluded.deleted, seq = excluded.seq`

const seed = (t: Tables): string =>
	`INSERT OR IGNORE INTO ${t.nodes}(${COLUMNS}) VALUES (${PLACEHOLDERS})`

/**
 * Which table set a store owns. One database holds more than one store: the
 * server's tree is the synced one, and its `/private` is a second store bound at
 * that name ([T15](../../../tasks/store-model/t15-mounts.md)) — local data is a
 * separate store joined at a name, and on this backend "separate" is these three
 * table names.
 */
type Tables = { nodes: string; blobs: string; meta: string }

const tablesOf = (namespace: string | undefined): Tables => {
	const prefix = namespace === undefined ? '' : `${namespace}_`
	return { nodes: `${prefix}nodes`, blobs: `${prefix}blobs`, meta: `${prefix}meta` }
}

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

/** The durable `Store`. Reopening the same database is not a reset. */
export function sqliteStore(db: SyncDb, opts?: { namespace?: string }): Store {
	const t = tablesOf(opts?.namespace)
	const SCHEMA = schema(t)
	const REPLACE = replace(t)
	let opened: string | undefined

	const start = (): string => {
		db.transactionSync(() => {
			for (const statement of SCHEMA) db.exec(statement)
			// The lineage (rule 11) and the root row (rule 6), each only on a
			// database that lacks it. A reopen finds both and keeps them — a restart
			// is not a reset, so it must not fence the replicas whose cursors this
			// store minted, nor overwrite a root whose mtime the volume has stamped.
			db.exec(`INSERT OR IGNORE INTO ${t.meta}(key, value) VALUES ('lineage', ?)`, [
				crypto.randomUUID()
			])
			db.exec(seed(t), bind(ROOT_ROW, 0))
		})
		const [row] = db.query<Row>(`SELECT value FROM ${t.meta} WHERE key = 'lineage' LIMIT 1`)
		return String(row?.value)
	}

	const open = (): string => (opened ??= start())

	const position = (cursor: Cursor | undefined, lineage: string): number => {
		if (cursor === undefined) return 0
		if (!cursor.startsWith(lineage + SEP)) throw new ForeignCursorError()
		return Number(cursor.slice(lineage.length + SEP.length))
	}

	const byId = (id: NodeId): Node | null => {
		const [found] = db.query<Row>(`SELECT * FROM ${t.nodes} WHERE id = ? LIMIT 1`, [id])
		return found ? decode(found) : null
	}

	// The live rows of one directory. Root is left out because it is nobody's
	// child — it is its own parent, so without this a listing of root would
	// contain root.
	const LIVE = `FROM ${t.nodes} WHERE parent = ? AND deleted = 0 AND id <> ?`

	const passes = (guard: Guard): boolean => {
		if ('free' in guard) {
			const held = db.query(`SELECT 1 AS held ${LIVE} AND name = ? LIMIT 1`, [
				guard.free.parent,
				ROOT,
				guard.free.name
			])
			return held.length === 0
		}
		// A tombstone is still a row, so a CAS against `null` fails on one: an id is
		// minted once and never rebound.
		const [found] = db.query<Row>(`SELECT version FROM ${t.nodes} WHERE id = ? LIMIT 1`, [
			guard.version.id
		])
		return (found ? String(found.version) : null) === guard.version.is
	}

	return {
		async get(id) {
			open()
			return byId(id)
		},

		async child(parent, name) {
			open()
			// Index records that share a `(parent, name)` are ordered by id, so the
			// first one back holds the lowest — rule 1's winner, without reading the
			// losers.
			const [found] = db.query<Row>(`SELECT * ${LIVE} AND name = ? ORDER BY id LIMIT 1`, [
				parent,
				ROOT,
				name
			])
			return found ? decode(found) : null
		},

		async children(parent, cursor) {
			open()
			const args: SqlValue[] = [parent, ROOT]
			// The cursor is just the last name emitted: a duplicate sorts next to its
			// winner, so dropping the whole name resumes the listing and drops the
			// losers in one step.
			if (cursor !== undefined) args.push(cursor)
			const rows = db.query<Row>(
				`SELECT * ${LIVE}${cursor === undefined ? '' : ' AND name > ?'}
					ORDER BY name, id LIMIT ${PAGE + 1}`,
				args
			)

			const nodes: Node[] = []
			let last = cursor
			let more = rows.length > PAGE // there is at least one record past this page
			for (const found of rows) {
				const name = String(found.name)
				if (name === last) continue // rule 1: one row per name, and the lowest id came first
				if (nodes.length === PAGE) {
					more = true
					break
				}
				nodes.push(decode(found))
				last = name
			}
			return more && last !== undefined ? { nodes, next: last } : { nodes }
		},

		/**
		 * Rule 4: each row once per scan, at its latest state, tombstones included.
		 * The `seq` index IS the order, so the scan is one ranged read and nothing
		 * is journaled behind it.
		 */
		async since(cursor) {
			const lineage = open()
			const from = position(cursor, lineage)
			const rows = db.query<Row>(
				`SELECT * FROM ${t.nodes} WHERE seq >= ? ORDER BY seq LIMIT ${PAGE + 1}`,
				[from]
			)
			const page = rows.slice(0, PAGE)
			const overflow = rows[PAGE]
			const last = page[page.length - 1]
			// Always a cursor back: a full page resumes AT the row that did not fit,
			// and a short one resumes past the last row it carried.
			const next = overflow ? toNumber(overflow.seq) : last ? toNumber(last.seq) + 1 : from
			return { nodes: page.map(decode), next: lineage + SEP + next }
		},

		/**
		 * Rule 2: every guard, then every write, in ONE ATOMIC transaction — both
		 * halves of the rule, which is what the synchronous seam buys. Nothing here
		 * touches anything but the database, so the state a guard passed against
		 * cannot move before the writes land, and a write that fails takes the
		 * whole batch back out with it.
		 */
		async commit(writes, guards) {
			// Taken before the first `await`, which is where the caller gets control
			// back and may edit a row it just handed over. What the guards see and
			// what lands has to be the batch as it stood at the call.
			const batch = structuredClone(writes)
			const checks = structuredClone(guards)

			open()
			db.transactionSync(() => {
				for (const guard of checks ?? []) if (!passes(guard)) throw new GuardError(guard)

				// The next position, read from the table rather than counted in
				// memory: another process commits into this same database, and two
				// rows sharing a seq would let a resumed cursor step over one of them.
				const [top] = db.query<Row>(`SELECT MAX(seq) AS top FROM ${t.nodes}`)
				let seq = toNumber(top?.top ?? -1) + 1

				for (const write of batch) {
					const old = byId(write.id)
					if (old && same(old, write)) continue // rule 3: a row the store already holds is a no-op
					db.exec(REPLACE, bind(write, seq++))
				}
			})
		},

		// No `subscribe`. Rule 8 makes it optional, and a consumer takes it INSTEAD
		// of polling `since` whenever a store offers one — which this backend cannot
		// honour: the DATABASE is the store, not the connection, so a wake held in
		// one process's closure would never fire for another's commit and a watcher
		// would go permanently stale rather than merely late. Polling `since` sees
		// every writer's commits.

		// Rule 7: content-keyed and immutable, so a hash the table already holds is
		// already the answer and the second put is nothing. SQLite hands every
		// reader its own buffer, so nothing here can reach into stored content.
		blobs: {
			async has(hash) {
				open()
				return (
					db.query(`SELECT 1 AS held FROM ${t.blobs} WHERE hash = ? LIMIT 1`, [hash]).length > 0
				)
			},
			async get(hash) {
				open()
				const [found] = db.query<Row>(`SELECT data FROM ${t.blobs} WHERE hash = ? LIMIT 1`, [hash])
				return found ? bytes(found.data) : null
			},
			async put(hash, data) {
				// Held before the first `await`: the caller may edit its array the
				// moment this call returns to it, and what lands must be what it
				// handed over.
				const held = new Uint8Array(data)
				open()
				db.exec(`INSERT OR IGNORE INTO ${t.blobs}(hash, data) VALUES (?, ?)`, [hash, held])
			}
		}
	}
}

// ── The row codec: one table row ↔ one `Node` ────────────────────────────────

type Row = Record<string, unknown>

const toNumber = (value: unknown): number =>
	typeof value === 'number' ? value : Number(value as number | bigint | string)

const toBigInt = (value: unknown): bigint =>
	typeof value === 'bigint' ? value : BigInt(String(value))

const text = (value: unknown): string | null => (value == null ? null : String(value))

/** A BLOB comes back as a `Uint8Array` from node:sqlite and an `ArrayBuffer` from the DO. */
const bytes = (value: unknown): Uint8Array =>
	value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value as ArrayBuffer)

// Small values only — the seam sends big data to `content` — so one JSON
// column of base64 holds every xattr a row has, and a row stays one row.
const encodeXattrs = (xattrs: Record<string, Uint8Array>): string =>
	JSON.stringify(
		Object.fromEntries(
			Object.entries(xattrs).map(([name, value]) => {
				let binary = ''
				for (const byte of value) binary += String.fromCharCode(byte)
				return [name, btoa(binary)]
			})
		)
	)

const decodeXattrs = (json: string): Record<string, Uint8Array> =>
	Object.fromEntries(
		Object.entries(JSON.parse(json) as Record<string, string>).map(([name, value]) => [
			name,
			Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
		])
	)

const bind = (node: Node, seq: number): SqlValue[] => [
	node.id,
	node.parent,
	node.name,
	node.type,
	node.mode,
	// Written as digits, never as a bigint binding: the DO's adapter would
	// stringify it anyway, and a TEXT column must hold the same characters on
	// every backend for the row to read back the same.
	String(node.mtimeNs),
	String(node.size),
	node.xattrs === undefined ? null : encodeXattrs(node.xattrs),
	node.content ?? null,
	node.link ?? null,
	node.version,
	node.deleted ? 1 : 0,
	seq
]

const decode = (row: Row): Node => {
	const node: Node = {
		id: String(row.id),
		parent: String(row.parent),
		name: String(row.name),
		type: String(row.type) as Node['type'],
		mode: toNumber(row.mode),
		mtimeNs: toBigInt(row.mtime_ns),
		size: toBigInt(row.size),
		version: String(row.version)
	}
	// The absent fields stay absent rather than becoming `undefined` keys: a row
	// read back must equal the row that was written, on every backend.
	const xattrs = text(row.xattrs)
	if (xattrs !== null) node.xattrs = decodeXattrs(xattrs)
	const content = text(row.content)
	if (content !== null) node.content = content
	const link = text(row.link)
	if (link !== null) node.link = link
	if (toNumber(row.deleted) !== 0) node.deleted = true
	return node
}
