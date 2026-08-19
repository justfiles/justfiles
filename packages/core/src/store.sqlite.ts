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
	type Hash,
	type Node,
	type NodeId,
	ROOT,
	type Store,
	same
} from '@justfiles/fs/store'
import type { SqlValue, SyncDb } from './db'

/** Rows per page. Big enough to list a normal directory in one page. */
const PAGE = 128

/**
 * Blobs per `gc` pass. The sweep shares one Durable Object event with every other
 * write, so it takes a slice and says whether more is left rather than holding the
 * object for the length of the backlog.
 */
const SWEEP = 128

/**
 * Bytes at or under this stay in the row; anything larger goes to the external store
 * when the host gave one.
 *
 * The number is not a tuning knob, it is a platform limit: a Workers SQLite ROW is
 * capped at 2 MB, hard, so a store that inlined everything could not hold a file
 * bigger than that at all — and the old backend already sent every binary to R2 for
 * the same reason. 256 KB is the old inline limit, well clear of the cap once a
 * hash, a key and a stamp are on the row beside the bytes.
 */
const INLINE = 256 * 1024

/**
 * Where bytes go when they are too big for a row: R2's shape, and nothing more of it
 * than this uses. It is the HOST's to scope — one bucket serves every Durable Object,
 * so the view handed in here must already be this host's.
 */
export type BlobStore = {
	put(key: string, value: ArrayBuffer | ArrayBufferView): Promise<unknown>
	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
	/** One key or a batch — R2's own signature, so a sweep costs one round trip per 1000. */
	delete?(keys: string | string[]): Promise<void>
}

/**
 * How long bytes are safe from the sweep after an adopter last TOUCHED them.
 *
 * Rule 10 puts the bytes in before the row that names them, and on a server those are
 * two REQUESTS with a gap between them. A sweep in that gap collects content the
 * pusher has already ticked off, and the engine never offers a pushed row's bytes
 * twice — so the row is a stub for ever, with no peer left that knows to re-send.
 *
 * There are TWO ways to be mid-adoption, which is why the stamp says "touched" and
 * not "written". A pusher holding the only copy PUTs the bytes and then commits. A
 * pusher whose bytes this store already has asks `has`, is told yes, skips the upload
 * — and then commits, with a `bases` round trip in between (`engine.ts`). The second
 * is the dangerous one: those bytes may have been unreferenced for weeks, so nothing
 * about when they were WRITTEN protects them, and only the ask says an adopter is
 * coming.
 *
 * An hour is far longer than one page of a push and far shorter than the daily sweep.
 */
const GRACE_MS = 60 * 60 * 1000

/**
 * The store every host has one of: the tree its volume is built over. A constant
 * id rather than a name, the way `ROOT` is the constant id of every store's root
 * row — and like that one, it means nothing outside the database that holds it.
 */
const MAIN = 'main'

/** NUL — the one byte a name can never hold, so composed keys never collide. */
const SEP = String.fromCharCode(0)

const COLUMNS =
	'sid, id, parent, name, type, mode, mtime_ns, size, xattrs, content, link, version, deleted, seq'
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
	// What a store IS, on this backend: a row here and a partition of the tables
	// below. Creating one is an INSERT — no DDL, no name in any statement — so a
	// host can open as many as it has places to join them, and `id` is the stable
	// identity its fstab keeps. The mount POINT's name lives in the parent store's
	// row and may be renamed there without any of this noticing.
	`CREATE TABLE IF NOT EXISTS stores (
		sid INTEGER PRIMARY KEY AUTOINCREMENT,
		id TEXT NOT NULL UNIQUE,
		created_ns TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS nodes (
		-- Which store's row this is. A narrow surrogate rather than the store's id,
		-- because it is on every row and every index entry of every store.
		sid INTEGER NOT NULL,
		id TEXT NOT NULL,
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
		seq INTEGER NOT NULL,
		-- An id is minted once and never rebound (rule 6) -- within its store. Two
		-- stores share the constant they both spell their root with, so identity
		-- here is the pair.
		PRIMARY KEY (sid, id)
	)`,
	// Live rows only, so a tombstone leaves the lookup by being written — no
	// delete, no second table. Not UNIQUE: rule 1 admits two live rows for one
	// name mid-sync and resolves them by the lowest id, and `id` is the last
	// index column so that winner is the first record read.
	'CREATE INDEX IF NOT EXISTS nodes_live ON nodes(sid, parent, name, id) WHERE deleted = 0',
	'CREATE INDEX IF NOT EXISTS nodes_seq ON nodes(sid, seq)',
	// Content is per store too. Sharing one map would make a hash in the local
	// store fetchable through the synced one's blob route, and rule 7 would then
	// be the only thing standing between them — the boundary has to be the data.
	// `touched_ms` is not part of the content map — a hash is still the whole key —
	// it is what `gc` needs to tell "no row names these bytes" from "no row names
	// them YET": the last moment an adopter wrote them or asked after them. Epoch
	// milliseconds as INTEGER: it is compared, and it is nowhere near the 2^53 the
	// two nanosecond fields above are.
	//
	// Exactly one of `data` and `blob_key` is set: the bytes are in the row, or the
	// row names where they are. Which one is a size question and nothing else (see
	// `INLINE`), so it is decided per blob and never revisited — content is immutable,
	// so the same hash is always the same length.
	`CREATE TABLE IF NOT EXISTS blobs (
		sid INTEGER NOT NULL,
		hash TEXT NOT NULL,
		data BLOB,
		blob_key TEXT,
		touched_ms INTEGER NOT NULL,
		PRIMARY KEY (sid, hash)
	)`,
	'CREATE TABLE IF NOT EXISTS meta (sid INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (sid, key))'
]

/** Rule 3: a write replaces the WHOLE row, so every column comes from the new one. */
const REPLACE = `INSERT INTO nodes(${COLUMNS}) VALUES (${PLACEHOLDERS})
	ON CONFLICT(sid, id) DO UPDATE SET
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

/**
 * The durable `Store`. Reopening the same database is not a reset.
 *
 * `id` names WHICH store: one database holds as many as the host has places to
 * join them — the server's synced tree, and the local one bound at `/private`.
 * It is a stable identity, never a name: it is carried as a bound parameter into
 * every statement, so nothing about a store's position or its mount point's name
 * reaches the schema, and renaming the mount is a `name` column in the PARENT
 * store's row. The default is the tree every host has one of.
 */
export function sqliteStore(
	db: SyncDb,
	id: string = MAIN,
	opts: { blobs?: BlobStore; inline?: number } = {}
): Store {
	let opened: Opened | undefined
	const external = opts.blobs
	const inline = opts.inline ?? INLINE
	// Content-addressed, and the store's id is in it: two stores over one database
	// never share an object, which is the same boundary `sid` draws on the table.
	const keyFor = (hash: Hash): string => `${id}/${hash}`
	/**
	 * The sweep's outstanding object deletes, which a new upload waits for.
	 *
	 * `gc` drops the rows and then deletes the objects, and that second half is network
	 * I/O — a Durable Object holds no input gate across it. So a push lands in the gap,
	 * finds no row, and re-uploads the same hash to the same derived key; if the delete
	 * already on its way then wins, the fresh row names an object that is gone, and the
	 * pusher's cursor has moved past the only offer of those bytes.
	 *
	 * A fresh key per adoption would dodge it, but a key derived from the hash is what
	 * makes a repeated put idempotent (see `put`). So the upload waits instead: one
	 * promise, one batch long, awaited only on the path that has a key at all.
	 */
	let sweeping: Promise<unknown> | undefined

	const start = (): Opened => {
		let sid = 0
		db.transactionSync(() => {
			for (const statement of SCHEMA) db.exec(statement)
			// The store itself, then the lineage (rule 11) and the root row (rule 6),
			// each only where it is missing. A reopen finds all three and keeps them —
			// a restart is not a reset, so it must not fence the replicas whose cursors
			// this store minted, nor overwrite a root whose mtime the volume stamped.
			db.exec('INSERT OR IGNORE INTO stores(id, created_ns) VALUES (?, ?)', [
				id,
				String(BigInt(Date.now()) * 1_000_000n)
			])
			const [store] = db.query<Row>('SELECT sid FROM stores WHERE id = ? LIMIT 1', [id])
			sid = toNumber(store?.sid)
			db.exec("INSERT OR IGNORE INTO meta(sid, key, value) VALUES (?, 'lineage', ?)", [
				sid,
				crypto.randomUUID()
			])
			db.exec(SEED, bind(sid, ROOT_ROW, 0))
		})
		const [row] = db.query<Row>(
			"SELECT value FROM meta WHERE sid = ? AND key = 'lineage' LIMIT 1",
			[sid]
		)
		return { sid, lineage: String(row?.value) }
	}

	const open = (): Opened => (opened ??= start())

	const position = (cursor: Cursor | undefined, lineage: string): number => {
		if (cursor === undefined) return 0
		if (!cursor.startsWith(lineage + SEP)) throw new ForeignCursorError()
		return Number(cursor.slice(lineage.length + SEP.length))
	}

	const byId = (sid: number, id: NodeId): Node | null => {
		const [found] = db.query<Row>('SELECT * FROM nodes WHERE sid = ? AND id = ? LIMIT 1', [sid, id])
		return found ? decode(found) : null
	}

	// The live rows of one directory. Root is left out because it is nobody's
	// child — it is its own parent, so without this a listing of root would
	// contain root.
	const LIVE = 'FROM nodes WHERE sid = ? AND parent = ? AND deleted = 0 AND id <> ?'

	const passes = (sid: number, guard: Guard): boolean => {
		if ('free' in guard) {
			const held = db.query(`SELECT 1 AS held ${LIVE} AND name = ? LIMIT 1`, [
				sid,
				guard.free.parent,
				ROOT,
				guard.free.name
			])
			return held.length === 0
		}
		// A tombstone is still a row, so a CAS against `null` fails on one: an id is
		// minted once and never rebound.
		const [found] = db.query<Row>('SELECT version FROM nodes WHERE sid = ? AND id = ? LIMIT 1', [
			sid,
			guard.version.id
		])
		return (found ? String(found.version) : null) === guard.version.is
	}

	return {
		async get(id) {
			const { sid } = open()
			return byId(sid, id)
		},

		async child(parent, name) {
			const { sid } = open()
			// Index records that share a `(parent, name)` are ordered by id, so the
			// first one back holds the lowest — rule 1's winner, without reading the
			// losers.
			const [found] = db.query<Row>(`SELECT * ${LIVE} AND name = ? ORDER BY id LIMIT 1`, [
				sid,
				parent,
				ROOT,
				name
			])
			return found ? decode(found) : null
		},

		async children(parent, cursor) {
			const { sid } = open()
			const args: SqlValue[] = [sid, parent, ROOT]
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
			const { sid, lineage } = open()
			const from = position(cursor, lineage)
			const rows = db.query<Row>(
				`SELECT * FROM nodes WHERE sid = ? AND seq >= ? ORDER BY seq LIMIT ${PAGE + 1}`,
				[sid, from]
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

			const { sid } = open()
			db.transactionSync(() => {
				for (const guard of checks ?? []) if (!passes(sid, guard)) throw new GuardError(guard)

				// The next position, read from the table rather than counted in
				// memory: another process commits into this same database, and two
				// rows sharing a seq would let a resumed cursor step over one of them.
				// Per store, so one store's writes never move another's feed.
				const [top] = db.query<Row>('SELECT MAX(seq) AS top FROM nodes WHERE sid = ?', [sid])
				let seq = toNumber(top?.top ?? -1) + 1

				for (const write of batch) {
					const old = byId(sid, write.id)
					if (old && same(old, write)) continue // rule 3: a row the store already holds is a no-op
					db.exec(REPLACE, bind(sid, write, seq++))
				}
			})
		},

		/**
		 * Rule 7 makes content immutable and hash-keyed, so nothing ever overwrites a
		 * blob — an edited file simply stops naming its old bytes, and those bytes are
		 * this store's to collect. Live rows only: a tombstone keeps whatever columns it
		 * was written with, and content a deleted row still names is content nobody can
		 * read.
		 *
		 * Per store, like everything else here: one store's rows can never keep
		 * another's bytes alive, which is the same boundary the blob table's `sid` draws.
		 */
		async gc() {
			const { sid } = open()
			let reclaimed = 0
			let done = true
			const keys: string[] = []
			db.transactionSync(() => {
				const orphans = db.query<Row>(
					`SELECT hash, blob_key FROM blobs
						WHERE sid = ? AND touched_ms < ? AND hash NOT IN (
							SELECT content FROM nodes WHERE sid = ? AND deleted = 0 AND content IS NOT NULL
						)
						LIMIT ${SWEEP + 1}`,
					[sid, Date.now() - GRACE_MS, sid]
				)
				// One past the slice is how a pass knows there is more, without counting
				// the whole backlog it deliberately did not read.
				done = orphans.length <= SWEEP
				for (const found of orphans.slice(0, SWEEP)) {
					db.exec('DELETE FROM blobs WHERE sid = ? AND hash = ?', [sid, String(found.hash)])
					const key = text(found.blob_key)
					if (key !== null) keys.push(key)
					reclaimed++
				}
			})
			// The external half, always AFTER the transaction that dropped the rows: an
			// object store can never join one, and the row is what makes the bytes
			// reachable. Losing these deletes leaks paid-for garbage; losing the rows
			// would be data loss, so this is the order that fails the right way.
			if (keys.length > 0) {
				sweeping = external?.delete?.(keys).catch(() => undefined)
				await sweeping
				sweeping = undefined
			}
			return { reclaimed, done }
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
			/**
			 * The ROW is what this store holds, whichever side the bytes are on: an
			 * external object with no row here belongs to nobody, and `gc` sweeps by row.
			 *
			 * Asking RENEWS the lease, and that is not a convenience. This question is
			 * the one a pusher asks before deciding not to upload (`transfer` in
			 * `engine.ts`), so a `true` here is a promise that the bytes will still be
			 * here when the commit naming them arrives — a commit that is two round trips
			 * away. Without the renewal a hash unreferenced since last week answers
			 * `true`, the sweep collects it in the gap, and the row lands naming content
			 * no peer will ever offer again.
			 *
			 * Guarded on the stamp, so the common case writes nothing: a blob touched
			 * within the last half-window is already safe for longer than the push, and
			 * an `UPDATE` that matches no row costs no write.
			 */
			async has(hash) {
				const { sid } = open()
				const held =
					db.query('SELECT 1 AS held FROM blobs WHERE sid = ? AND hash = ? LIMIT 1', [sid, hash])
						.length > 0
				if (held)
					db.exec('UPDATE blobs SET touched_ms = ? WHERE sid = ? AND hash = ? AND touched_ms < ?', [
						Date.now(),
						sid,
						hash,
						Date.now() - GRACE_MS / 2
					])
				return held
			},
			async get(hash) {
				const { sid } = open()
				const [found] = db.query<Row>(
					'SELECT data, blob_key FROM blobs WHERE sid = ? AND hash = ? LIMIT 1',
					[sid, hash]
				)
				if (!found) return null
				if (found.data != null) return bytes(found.data)
				const key = text(found.blob_key)
				// A row naming an object nobody can produce is the seam's own answer to
				// content that is not here: `null`, and the reader is told.
				if (key === null || !external) return null
				const object = await external.get(key)
				return object === null ? null : new Uint8Array(await object.arrayBuffer())
			},
			async put(hash, data) {
				// Held before the first `await`: the caller may edit its array the
				// moment this call returns to it, and what lands must be what it
				// handed over.
				const held = new Uint8Array(data)
				const { sid } = open()
				const stamp = Date.now()
				if (external === undefined || held.byteLength <= inline) {
					db.exec(
						'INSERT OR IGNORE INTO blobs(sid, hash, data, blob_key, touched_ms) VALUES (?, ?, ?, NULL, ?)',
						[sid, hash, held, stamp]
					)
					return
				}
				// Rule 7 makes content immutable, so a hash this store already holds is
				// already the answer — and skipping here is what keeps a re-run of the
				// one pass from re-uploading a volume it already moved.
				if (
					db.query('SELECT 1 AS held FROM blobs WHERE sid = ? AND hash = ? LIMIT 1', [sid, hash])
						.length > 0
				)
					return
				// Bytes BEFORE the row, the way rule 10 puts them before the node that
				// names them: a failure here leaves an unreferenced object, which is
				// garbage, rather than a row whose bytes were never stored, which is a
				// hole. The key is derived from the hash, so a repeat writes the same
				// object to the same place.
				const key = keyFor(hash)
				// A sweep may be deleting this very key right now, and it dropped the row
				// this put just found missing (see `sweeping`).
				await sweeping
				await external.put(key, held)
				db.exec(
					'INSERT OR IGNORE INTO blobs(sid, hash, data, blob_key, touched_ms) VALUES (?, ?, NULL, ?, ?)',
					[sid, hash, key, stamp]
				)
			}
		}
	}
}

/**
 * Empty one store and start it on a NEW LINEAGE: the authority half of "take mine",
 * and the whole of a wipe.
 *
 * A lineage rather than a flag, because rule 11 is what this model fences with. Every
 * replica's pull cursor was minted by the lineage this replaces, so the next `since`
 * over any of them throws `ForeignCursorError` and that replica scans the emptied feed
 * from the top — including the one that ASKED for the reset, whose own cursor is no
 * more valid than anybody else's. Nothing has to be told; the cursors say it.
 *
 * The root row stays. It is a constant on every store (rule 6), so removing and
 * re-seeding it would be a write that says nothing, and a store with no root is one no
 * volume can read.
 *
 * `content: 'keep'` is what an adopt-mine wants: the initiator republishes rows it may
 * only hold as stubs, and the bytes behind them are already here. A wipe drops them,
 * because "delete everything" must not leave the discarded bytes fetchable by hash.
 *
 * It drops the ROWS, which is what makes the bytes unfetchable — an offloaded object
 * is only reachable through the row that names its key. Objects in an external store
 * are left where they are: this body is synchronous, deliberately (it shares the CAS's
 * transaction), and an object store can never join one. The old model's wipe left them
 * too, for the same reason, so this leaks no more than it used to.
 *
 * NO TRANSACTION OF ITS OWN — the caller owns one, because the only caller commits
 * this together with the CAS that authorised it (`resetStore` in `reset.ts`). And any
 * `sqliteStore` handle already open over this store is STALE afterwards: it holds the
 * lineage it read at open, so it would keep minting cursors of a lineage this just
 * replaced. Frieren's reset answers that by taking the whole instance down with it.
 */
export function emptyStore(db: SyncDb, id: string = MAIN, opts?: { content?: 'keep' | 'drop' }) {
	// The store's schema is the CALLER's to have created, by holding a `sqliteStore`
	// over this database — which frieren's host does at boot, announcing its mount
	// before any request can reach it. A store that exists but was never written to
	// holds nothing, which is already what this was asked for.
	const [store] = db.query<Row>('SELECT sid FROM stores WHERE id = ? LIMIT 1', [id])
	if (!store) return
	const sid = toNumber(store.sid)
	db.exec('DELETE FROM nodes WHERE sid = ? AND id <> ?', [sid, ROOT])
	if (opts?.content === 'drop') db.exec('DELETE FROM blobs WHERE sid = ?', [sid])
	db.exec("UPDATE meta SET value = ? WHERE sid = ? AND key = 'lineage'", [crypto.randomUUID(), sid])
}

// ── The row codec: one table row ↔ one `Node` ────────────────────────────────

type Row = Record<string, unknown>

/** What one `open()` settles: which partition this store is, and its lineage (rule 11). */
type Opened = { sid: number; lineage: string }

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

const bind = (sid: number, node: Node, seq: number): SqlValue[] => [
	sid,
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
