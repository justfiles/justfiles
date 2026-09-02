/**
 * GC-capable authority store: signed cursors, write leases, and two-stage
 * tombstone retention over the durable SQLite backend.
 */

import {
	type LeasedPeer,
	leasedPeer,
	mutexLock,
	newSecret,
	type PendingFence,
	type PushCursorProvider,
	type ReceiverClock,
	type ReceiverContext,
	type ReceiverState,
	type SyncLock
} from '@justfiles/fs/lease'
import { type Guard, GuardError, type Node, ROOT, type Store, same } from '@justfiles/fs/store'
import { DEFAULT_SYNC_POLICY, type SyncPolicy, validateSyncPolicy } from '@justfiles/fs/sync-policy'
import type { SqlValue, SyncDb } from './db'
import { type BlobStore, sqliteStore } from './store.sqlite'

const MAIN = 'main'

type Row = Record<string, unknown>

const toNumber = (value: unknown): number =>
	typeof value === 'number' ? value : Number(value as number | bigint | string)

const metaGet = (db: SyncDb, sid: number, key: string): string | undefined => {
	const [row] = db.query<Row>('SELECT value FROM meta WHERE sid = ? AND key = ? LIMIT 1', [
		sid,
		key
	])
	return row ? String(row.value) : undefined
}

const metaSet = (db: SyncDb, sid: number, key: string, value: string): void => {
	db.exec('INSERT OR REPLACE INTO meta(sid, key, value) VALUES (?, ?, ?)', [sid, key, value])
}

const loadState = (db: SyncDb, sid: number, lineage: string): ReceiverState => {
	const secretB64 = metaGet(db, sid, 'signing_secret')
	const secret = secretB64 ? Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0)) : newSecret()
	if (!secretB64) metaSet(db, sid, 'signing_secret', btoa(String.fromCharCode(...secret)))
	const feedFloor = Number(metaGet(db, sid, 'feed_floor') ?? '0')
	let feedHead = Number(metaGet(db, sid, 'feed_head') ?? 'NaN')
	if (Number.isNaN(feedHead)) {
		const [top] = db.query<Row>('SELECT MAX(seq) AS top FROM nodes WHERE sid = ?', [sid])
		feedHead = toNumber(top?.top ?? -1) + 1
	}
	const fenceRaw = metaGet(db, sid, 'pending_fence')
	const pendingFence = fenceRaw ? (JSON.parse(fenceRaw) as PendingFence) : null
	return { lineage, secret, feedFloor, feedHead, pendingFence }
}

const saveState = (db: SyncDb, sid: number, state: ReceiverState): void => {
	metaSet(db, sid, 'feed_floor', String(state.feedFloor))
	metaSet(db, sid, 'feed_head', String(state.feedHead))
	if (state.pendingFence) metaSet(db, sid, 'pending_fence', JSON.stringify(state.pendingFence))
	else db.exec("DELETE FROM meta WHERE sid = ? AND key = 'pending_fence'", [sid])
}

const passes = (db: SyncDb, sid: number, guard: Guard): boolean => {
	if ('free' in guard) {
		const held = db.query(
			'SELECT 1 AS held FROM nodes WHERE sid = ? AND parent = ? AND name = ? AND deleted = 0 AND id <> ? LIMIT 1',
			[sid, guard.free.parent, guard.free.name, ROOT]
		)
		return held.length === 0
	}
	const [found] = db.query<Row>('SELECT version FROM nodes WHERE sid = ? AND id = ? LIMIT 1', [
		sid,
		guard.version.id
	])
	return (found ? String(found.version) : null) === guard.version.is
}

export type SqliteLeasedOpts = {
	blobs?: BlobStore
	inline?: number
	policy?: SyncPolicy
	lock?: SyncLock
	pushCursor?: PushCursorProvider
	clock?: ReceiverClock
	wrap?: (store: Store) => Store
}

export type SqliteLeased = LeasedPeer & {
	ctx: ReceiverContext
	local: Store
	source: Store
	localCommit(writes: Node[], guards?: Guard[]): Promise<void>
	gc(): Promise<{ reclaimed: number; done: boolean }>
}

export function sqliteLeasedStore(
	db: SyncDb,
	id: string = MAIN,
	opts: SqliteLeasedOpts = {}
): SqliteLeased {
	validateSyncPolicy(opts.policy ?? DEFAULT_SYNC_POLICY)

	const policy = opts.policy ?? DEFAULT_SYNC_POLICY
	const lock = opts.lock ?? mutexLock()
	const base = sqliteStore(db, id, { blobs: opts.blobs, inline: opts.inline })

	const sidOf = (): number => {
		const [store] = db.query<Row>('SELECT sid FROM stores WHERE id = ? LIMIT 1', [id])
		return toNumber(store?.sid)
	}

	let clockMs = Date.now()
	const source: ReceiverClock = opts.clock ?? { now: Date.now, tick: () => {} }
	const clock: ReceiverClock = {
		now: () => Math.max(clockMs, source.now()),
		tick: (value) => {
			clockMs = Math.max(clockMs, value)
			source.tick(clockMs)
			const [store] = db.query<Row>('SELECT sid FROM stores WHERE id = ? LIMIT 1', [id])
			if (store) metaSet(db, toNumber(store.sid), 'receiver_clock', String(clockMs))
		}
	}

	const ctx: ReceiverContext = {
		state: { lineage: '', secret: newSecret(), feedFloor: 0, feedHead: 0, pendingFence: null },
		clock,
		lock,
		policy,
		pushCursor: opts.pushCursor
	}
	let retentionReady = false

	const refresh = (): void => {
		void base.get(ROOT)
		if (!retentionReady) {
			ensureRetentionSchema(db)
			retentionReady = true
		}
		const sid = sidOf()
		const lineage = metaGet(db, sid, 'lineage') ?? ctx.state.lineage
		const held = metaGet(db, sid, 'receiver_clock')
		if (held) clockMs = Math.max(clockMs, Number(held))
		Object.assign(ctx.state, loadState(db, sid, lineage))
		saveState(db, sid, ctx.state)
	}

	const gc = async (): Promise<{ reclaimed: number; done: boolean }> => {
		refresh()
		const sid = sidOf()
		const now = clock.now()
		clock.tick(now)
		metaSet(db, sid, 'receiver_clock', String(now))
		const tombstones = await lock.run(async () => tombstoneGc(db, sid, ctx, now))
		const blobs = (await base.gc?.()) ?? { reclaimed: 0, done: true }
		return {
			reclaimed: tombstones.reclaimed + blobs.reclaimed,
			done: tombstones.done && blobs.done
		}
	}

	const tracking: Store = {
		...base,
		async commit(writes, guards) {
			refresh()
			const sid = sidOf()
			const batch = structuredClone(writes)
			const checks = structuredClone(guards)
			const now = clock.now()
			clock.tick(now)
			metaSet(db, sid, 'receiver_clock', String(now))
			let nextHead = ctx.state.feedHead
			db.transactionSync(() => {
				for (const guard of checks ?? []) if (!passes(db, sid, guard)) throw new GuardError(guard)
				let seq = nextHead
				for (const write of batch) {
					const [oldRow] = db.query<Row>('SELECT * FROM nodes WHERE sid = ? AND id = ? LIMIT 1', [
						sid,
						write.id
					])
					if (oldRow && sameRow(oldRow, write)) continue
					db.exec(
						`INSERT INTO nodes(sid, id, parent, name, type, mode, mtime_ns, size, xattrs, content, link, version, deleted, seq, commit_ms)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT(sid, id) DO UPDATE SET
						 parent = excluded.parent, name = excluded.name, type = excluded.type,
						 mode = excluded.mode, mtime_ns = excluded.mtime_ns, size = excluded.size,
						 xattrs = excluded.xattrs, content = excluded.content, link = excluded.link,
						 version = excluded.version, deleted = excluded.deleted, seq = excluded.seq,
						 commit_ms = excluded.commit_ms`,
						bindNode(sid, write, seq, now)
					)
					seq++
				}
				nextHead = seq
				metaSet(db, sid, 'feed_head', String(nextHead))
			})
			ctx.state.feedHead = nextHead
		},
		gc
	}

	const local = opts.wrap?.(tracking) ?? tracking
	const peer = leasedPeer(local, ctx)
	return {
		get: local.get,
		child: local.child,
		children: local.children,
		blobs: { has: local.blobs.has, get: local.blobs.get },
		async since(cursor) {
			refresh()
			return peer.since(cursor)
		},
		async open(cursor) {
			refresh()
			return peer.open(cursor)
		},
		async put(lease, hash, data) {
			refresh()
			return peer.put(lease, hash, data)
		},
		async commit(lease, writes, guards) {
			refresh()
			return peer.commit(lease, writes, guards)
		},
		/** Receiver-local writes that record commit_ms (not lease-gated). */
		localCommit: local.commit.bind(local),
		gc,
		local,
		source: tracking,
		ctx
	}
}

function ensureRetentionSchema(db: SyncDb): void {
	const columns = db.query<{ name: unknown }>('PRAGMA table_info(nodes)')
	if (!columns.some((column) => String(column.name) === 'commit_ms'))
		db.exec('ALTER TABLE nodes ADD COLUMN commit_ms INTEGER')
	db.exec(
		'CREATE INDEX IF NOT EXISTS nodes_tombstone_seq ON nodes(sid, deleted, seq, commit_ms) WHERE deleted = 1'
	)
}

const sameRow = (row: Row, write: Node): boolean => same(decodeNode(row), write)

const encodeXattrs = (xattrs: Record<string, Uint8Array>): string =>
	JSON.stringify(
		Object.fromEntries(
			Object.entries(xattrs).map(([name, value]) => [name, btoa(String.fromCharCode(...value))])
		)
	)

const decodeXattrs = (value: string): Record<string, Uint8Array> =>
	Object.fromEntries(
		Object.entries(JSON.parse(value) as Record<string, string>).map(([name, data]) => [
			name,
			Uint8Array.from(atob(data), (character) => character.charCodeAt(0))
		])
	)

const decodeNode = (row: Row): Node => {
	const node: Node = {
		id: String(row.id),
		parent: String(row.parent),
		name: String(row.name),
		type: String(row.type) as Node['type'],
		mode: toNumber(row.mode),
		mtimeNs: BigInt(String(row.mtime_ns)),
		size: BigInt(String(row.size)),
		version: String(row.version)
	}
	if (row.xattrs != null) node.xattrs = decodeXattrs(String(row.xattrs))
	if (row.content != null) node.content = String(row.content)
	if (row.link != null) node.link = String(row.link)
	if (toNumber(row.deleted) !== 0) node.deleted = true
	return node
}

const bindNode = (sid: number, node: Node, seq: number, commitMs: number): SqlValue[] => [
	sid,
	node.id,
	node.parent,
	node.name,
	node.type,
	node.mode,
	String(node.mtimeNs),
	String(node.size),
	node.xattrs === undefined ? null : encodeXattrs(node.xattrs),
	node.content ?? null,
	node.link ?? null,
	node.version,
	node.deleted ? 1 : 0,
	seq,
	commitMs
]

async function tombstoneGc(
	db: SyncDb,
	sid: number,
	ctx: ReceiverContext,
	now: number
): Promise<{ reclaimed: number; done: boolean }> {
	const { state, policy } = ctx

	if (state.pendingFence) {
		const { through, fencedAt } = state.pendingFence
		if (now < fencedAt + policy.tombstoneGraceMs) return { reclaimed: 0, done: true }
		const ack = await pushFloor(ctx)
		if (ack === undefined || ack <= through) return { reclaimed: 0, done: true }
		let reclaimed = 0
		let done = true
		let clear = false
		db.transactionSync(() => {
			const rows = db.query<Row>(
				'SELECT id FROM nodes WHERE sid = ? AND deleted = 1 AND seq <= ? ORDER BY seq LIMIT ?',
				[sid, through, policy.deleteBatch + 1]
			)
			done = rows.length <= policy.deleteBatch
			for (const row of rows.slice(0, policy.deleteBatch)) {
				db.exec('DELETE FROM nodes WHERE sid = ? AND id = ?', [sid, String(row.id)])
				reclaimed++
			}
			if (done) {
				const left = db.query<Row>(
					'SELECT 1 AS held FROM nodes WHERE sid = ? AND deleted = 1 AND seq <= ? LIMIT 1',
					[sid, through]
				)
				clear = left.length === 0
			}
			if (clear) db.exec("DELETE FROM meta WHERE sid = ? AND key = 'pending_fence'", [sid])
		})
		if (clear) state.pendingFence = null
		if (reclaimed > 0) return { reclaimed, done: done && state.pendingFence === null }
		if (!done) return { reclaimed: 0, done: false }
		return { reclaimed: 0, done: true }
	}

	const ack = await pushFloor(ctx)
	if (ack === undefined) return { reclaimed: 0, done: true }

	const cutoff = now - policy.tombstoneFenceAgeMs
	const [row] = db.query<Row>(
		`SELECT MAX(seq) AS through FROM nodes
		 WHERE sid = ? AND deleted = 1 AND commit_ms IS NOT NULL AND commit_ms <= ? AND seq < ?`,
		[sid, cutoff, ack]
	)
	const through = row?.through == null ? null : toNumber(row.through)
	if (through === null) return { reclaimed: 0, done: true }

	const feedFloor = Math.max(state.feedFloor, through + 1)
	const pendingFence = { through, fencedAt: now }
	db.transactionSync(() => {
		metaSet(db, sid, 'feed_floor', String(feedFloor))
		metaSet(db, sid, 'pending_fence', JSON.stringify(pendingFence))
	})
	state.feedFloor = feedFloor
	state.pendingFence = pendingFence
	return { reclaimed: 0, done: true }
}

async function pushFloor(ctx: ReceiverContext): Promise<number | undefined> {
	if (!ctx.pushCursor) return Number.POSITIVE_INFINITY
	const held = await ctx.pushCursor()
	if (held === undefined) return undefined
	const cursors = typeof held === 'string' ? [held] : held
	if (cursors.length === 0) return Number.POSITIVE_INFINITY
	let floor = Number.POSITIVE_INFINITY
	const prefix = ctx.state.lineage + String.fromCharCode(0)
	for (const cursor of cursors) {
		if (!cursor.startsWith(prefix)) return undefined
		const position = Number(cursor.slice(prefix.length))
		if (!Number.isSafeInteger(position) || position < 0) return undefined
		floor = Math.min(floor, position)
	}
	return floor
}
