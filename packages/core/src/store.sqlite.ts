/**
 * The authority's durable `Store`. One `nodes` table with the two lookups and
 * the one order as indexes over it, one `blobs` table, and one `meta` row for
 * the lineage — the same schema the model has on every other backend.
 *
 * It takes a `DbAdapter` (`db.ts`), so the same code runs on `node:sqlite`
 * under vitest and on the Durable Object's SQLite in production. The whole of
 * `commit` — every guard and every write — is one `db.transaction`: a guard
 * evaluated in a transaction the writes do not share is a race, not a guard.
 * Every guard runs before any write, so a rejection has written nothing to roll
 * back — which is how rule 2 also holds on the Durable Object, whose
 * `transaction` is a bare wrapper with no rollback of its own.
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
import type { DbAdapter, SqlValue } from './db'

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
const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS nodes (
		id TEXT PRIMARY KEY,
		parent TEXT NOT NULL,
		name TEXT NOT NULL COLLATE BINARY,
		type TEXT NOT NULL,
		mode INTEGER NOT NULL,
		mtime_ns INTEGER NOT NULL,
		size INTEGER NOT NULL,
		xattrs TEXT,
		content TEXT,
		link TEXT,
		version TEXT NOT NULL,
		deleted INTEGER NOT NULL DEFAULT 0,
		seq INTEGER NOT NULL
	)`,
	// Live rows only, so a tombstone leaves the lookup by being written — no
	// delete, no second table. Not UNIQUE: rule 1 admits two live rows for one
	// name mid-sync and resolves them by the lowest id, and `id` is the last
	// index column so that winner is the first record read.
	'CREATE INDEX IF NOT EXISTS nodes_live ON nodes(parent, name, id) WHERE deleted = 0',
	'CREATE INDEX IF NOT EXISTS nodes_seq ON nodes(seq)',
	'CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, data BLOB NOT NULL)',
	'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
]

/** Rule 3: a write replaces the WHOLE row, so every column comes from the new one. */
const REPLACE = `INSERT INTO nodes(${COLUMNS}) VALUES (${PLACEHOLDERS})
	ON CONFLICT(id) DO UPDATE SET
		parent = excluded.parent, name = excluded.name, type = excluded.type,
		mode = excluded.mode, mtime_ns = excluded.mtime_ns, size = excluded.size,
		xattrs = excluded.xattrs, content = excluded.content, link = excluded.link,
		version = excluded.version, deleted = excluded.deleted, seq = excluded.seq`

const SEED = `INSERT OR IGNORE INTO nodes(${COLUMNS}) VALUES (${PLACEHOLDERS})`

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
export function sqliteStore(db: DbAdapter): Store {
	let opening: Promise<string> | null = null

	const start = async (): Promise<string> => {
		await db.transaction(async (tx) => {
			for (const statement of SCHEMA) await tx.run(statement)
			// The lineage (rule 11) and the root row (rule 6), each only on a
			// database that lacks it. A reopen finds both and keeps them — a restart
			// is not a reset, so it must not fence the replicas whose cursors this
			// store minted, nor overwrite a root whose mtime the volume has stamped.
			await tx.run("INSERT OR IGNORE INTO meta(key, value) VALUES ('lineage', ?)", [
				crypto.randomUUID()
			])
			await tx.run(SEED, bind(ROOT_ROW, 0))
		})
		const [row] = await db.query<Row>("SELECT value FROM meta WHERE key = 'lineage' LIMIT 1")
		return String(row?.value)
	}

	const open = (): Promise<string> => (opening ??= start())

	const position = (cursor: Cursor | undefined, lineage: string): number => {
		if (cursor === undefined) return 0
		if (!cursor.startsWith(lineage + SEP)) throw new ForeignCursorError()
		return Number(cursor.slice(lineage.length + SEP.length))
	}

	const byId = async (tx: DbAdapter, id: NodeId): Promise<Node | null> => {
		const [found] = await tx.query<Row>('SELECT * FROM nodes WHERE id = ? LIMIT 1', [id])
		return found ? decode(found) : null
	}

	// The live rows of one directory. Root is left out because it is nobody's
	// child — it is its own parent, so without this a listing of root would
	// contain root.
	const LIVE = 'FROM nodes WHERE parent = ? AND deleted = 0 AND id <> ?'

	const passes = async (tx: DbAdapter, guard: Guard): Promise<boolean> => {
		if ('free' in guard) {
			const held = await tx.query(`SELECT 1 AS held ${LIVE} AND name = ? LIMIT 1`, [
				guard.free.parent,
				ROOT,
				guard.free.name
			])
			return held.length === 0
		}
		// A tombstone is still a row, so a CAS against `null` fails on one: an id is
		// minted once and never rebound.
		const [found] = await tx.query<Row>('SELECT version FROM nodes WHERE id = ? LIMIT 1', [
			guard.version.id
		])
		return (found ? String(found.version) : null) === guard.version.is
	}

	return {
		async get(id) {
			await open()
			return byId(db, id)
		},

		async child(parent, name) {
			await open()
			// Index records that share a `(parent, name)` are ordered by id, so the
			// first one back holds the lowest — rule 1's winner, without reading the
			// losers.
			const [found] = await db.query<Row>(`SELECT * ${LIVE} AND name = ? ORDER BY id LIMIT 1`, [
				parent,
				ROOT,
				name
			])
			return found ? decode(found) : null
		},

		async children(parent, cursor) {
			await open()
			const args: SqlValue[] = [parent, ROOT]
			// The cursor is just the last name emitted: a duplicate sorts next to its
			// winner, so dropping the whole name resumes the listing and drops the
			// losers in one step.
			if (cursor !== undefined) args.push(cursor)
			const rows = await db.query<Row>(
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
			const lineage = await open()
			const from = position(cursor, lineage)
			const rows = await db.query<Row>(
				`SELECT * FROM nodes WHERE seq >= ? ORDER BY seq LIMIT ${PAGE + 1}`,
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
		 * Rule 2: every guard, then every write, in ONE transaction. Nothing here
		 * awaits anything but the database, so the state a guard passed against
		 * cannot move before the writes land.
		 */
		async commit(writes, guards) {
			// Taken before the first `await`, which is where the caller gets control
			// back and may edit a row it just handed over. What the guards see and
			// what lands has to be the batch as it stood at the call.
			const batch = structuredClone(writes)
			const checks = structuredClone(guards)

			await open()
			await db.transaction(async (tx) => {
				for (const guard of checks ?? [])
					if (!(await passes(tx, guard))) throw new GuardError(guard)

				// The next position, read from the table rather than counted in
				// memory: another process commits into this same database, and two
				// rows sharing a seq would let a resumed cursor step over one of them.
				const [top] = await tx.query<Row>('SELECT MAX(seq) AS top FROM nodes')
				let seq = toNumber(top?.top ?? -1) + 1

				for (const write of batch) {
					const old = await byId(tx, write.id)
					if (old && same(old, write)) continue // rule 3: a row the store already holds is a no-op
					await tx.run(REPLACE, bind(write, seq++))
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
				await open()
				return (
					(await db.query('SELECT 1 AS held FROM blobs WHERE hash = ? LIMIT 1', [hash])).length > 0
				)
			},
			async get(hash) {
				await open()
				const [found] = await db.query<Row>('SELECT data FROM blobs WHERE hash = ? LIMIT 1', [hash])
				return found ? bytes(found.data) : null
			},
			async put(hash, data) {
				// Held before the first `await`: the caller may edit its array the
				// moment this call returns to it, and what lands must be what it
				// handed over.
				const held = new Uint8Array(data)
				await open()
				await db.run('INSERT OR IGNORE INTO blobs(hash, data) VALUES (?, ?)', [hash, held])
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
	node.mtimeNs,
	node.size,
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
