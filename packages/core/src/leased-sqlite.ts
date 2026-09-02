/**
 * GC-capable authority store: signed cursors, write leases, and two-stage
 * tombstone retention over the durable SQLite backend.
 */

import {
	type LeasedStore,
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
import { DEFAULT_SYNC_POLICY, type SyncPolicy, validateSyncPolicy } from '@justfiles/fs/sync-policy'
import { type Guard, GuardError, type Node, ROOT, type Store, forwarded, same } from '@justfiles/fs/store'
import type { SqlValue, SyncDb } from './db'
import { migrateSync } from './migrations/utils'
import { type BlobStore, sqliteStore } from './store.sqlite'

const MIGRATION_13 = `
ALTER TABLE nodes ADD COLUMN commit_ms INTEGER;
CREATE INDEX IF NOT EXISTS nodes_tombstone_seq ON nodes(sid, deleted, seq, commit_ms)
	WHERE deleted = 1;
`

const MAIN = 'main'

type Row = Record<string, unknown>

const toNumber = (value: unknown): number =>
	typeof value === 'number' ? value : Number(value as number | bigint | string)

const metaGet = (db: SyncDb, sid: number, key: string): string | undefined => {
	const [row] = db.query<Row>('SELECT value FROM meta WHERE sid = ? AND key = ? LIMIT 1', [sid, key])
	return row ? String(row.value) : undefined
}

const metaSet = (db: SyncDb, sid: number, key: string, value: string): void => {
	db.exec('INSERT OR REPLACE INTO meta(sid, key, value) VALUES (?, ?, ?)', [sid, key, value])
}

const loadState = (db: SyncDb, sid: number, lineage: string): ReceiverState => {
	const secretB64 = metaGet(db, sid, 'signing_secret')
	const secret = secretB64
		? Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0))
		: newSecret()
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
}

export type SqliteLeased = LeasedStore & {
	ctx: ReceiverContext
	localCommit(writes: Node[], guards?: Guard[]): Promise<void>
	gc(): Promise<{ reclaimed: number; done: boolean }>
}

export async function sqliteLeasedStore(
	db: SyncDb,
	id: string = MAIN,
	opts: SqliteLeasedOpts = {}
): Promise<SqliteLeased> {
	validateSyncPolicy(opts.policy ?? DEFAULT_SYNC_POLICY)

	const policy = opts.policy ?? DEFAULT_SYNC_POLICY
	const lock = opts.lock ?? mutexLock()
	const base = sqliteStore(db, id, { blobs: opts.blobs, inline: opts.inline })
	await base.get(ROOT)
	migrateSync(db, [{ version: 13, sql: MIGRATION_13 }])

	const sidOf = (): number => {
		const [store] = db.query<Row>('SELECT sid FROM stores WHERE id = ? LIMIT 1', [id])
		return toNumber(store?.sid)
	}

	let clockMs = 1_700_000_000_000
	const clock: ReceiverClock =
		opts.clock ??
		({
			now: () => clockMs,
			tick: (now) => {
				clockMs = Math.max(clockMs, now)
			}
		} as ReceiverClock)

	const ctx: ReceiverContext = {
		state: { lineage: '', secret: newSecret(), feedFloor: 0, feedHead: 0, pendingFence: null },
		clock,
		lock,
		policy,
		pushCursor: opts.pushCursor
	}

	const refresh = (): void => {
		const sid = sidOf()
		const lineage = metaGet(db, sid, 'lineage') ?? ctx.state.lineage
		const held = metaGet(db, sid, 'receiver_clock')
		if (held) clock.tick(Number(held))
		Object.assign(ctx.state, loadState(db, sid, lineage))
		saveState(db, sid, ctx.state)
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
			db.transactionSync(() => {
				for (const guard of checks ?? []) if (!passes(db, sid, guard)) throw new GuardError(guard)
				let seq = ctx.state.feedHead
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
				ctx.state.feedHead = seq
				saveState(db, sid, ctx.state)
			})
		},
		async gc() {
			refresh()
			const sid = sidOf()
			const now = clock.now()
			clock.tick(now)
			metaSet(db, sid, 'receiver_clock', String(now))
			return lock.run(async () => tombstoneGc(db, sid, ctx, base, now))
		}
	}

	refresh()
	const peer = leasedPeer(tracking, ctx)
	return {
		...forwarded(tracking),
		since: peer.since.bind(peer),
		open: peer.open.bind(peer),
		put: peer.put.bind(peer),
		commit: peer.commit.bind(peer),
		/** Receiver-local writes that record commit_ms (not lease-gated). */
		localCommit: tracking.commit.bind(tracking),
		gc: tracking.gc!.bind(tracking),
		ctx
	}
}

const sameRow = (row: Row, write: Node): boolean =>
	same(
		{
			id: String(row.id),
			parent: String(row.parent),
			name: String(row.name),
			type: String(row.type) as Node['type'],
			mode: toNumber(row.mode),
			mtimeNs: BigInt(String(row.mtime_ns)),
			size: BigInt(String(row.size)),
			version: String(row.version),
			deleted: toNumber(row.deleted) !== 0 ? true : undefined
		},
		write
	)

const bindNode = (sid: number, node: Node, seq: number, commitMs: number): SqlValue[] => [
	sid,
	node.id,
	node.parent,
	node.name,
	node.type,
	node.mode,
	String(node.mtimeNs),
	String(node.size),
	null,
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
	base: Store,
	now: number
): Promise<{ reclaimed: number; done: boolean }> {
	const { state, policy, pushCursor } = ctx

	if (state.pendingFence) {
		const { through, fencedAt } = state.pendingFence
		if (now < fencedAt + policy.tombstoneGraceMs) return { reclaimed: 0, done: true }
		const ack = pushCursor ? await pushCursor() : Number.POSITIVE_INFINITY
		if (ack === undefined || ack <= through) return { reclaimed: 0, done: true }
		let reclaimed = 0
		let done = true
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
				if (left.length === 0) state.pendingFence = null
			}
		})
		saveState(db, sid, state)
		if (reclaimed > 0) return { reclaimed, done: done && state.pendingFence === null }
		if (!done) return { reclaimed: 0, done: false }
		return { reclaimed: 0, done: true }
	}

	const ack = pushCursor ? await pushCursor() : Number.POSITIVE_INFINITY
	if (ack === undefined) return { reclaimed: 0, done: true }

	const cutoff = now - policy.tombstoneFenceAgeMs
	const [row] = db.query<Row>(
		`SELECT MAX(seq) AS through FROM nodes
		 WHERE sid = ? AND deleted = 1 AND commit_ms IS NOT NULL AND commit_ms < ? AND seq < ?`,
		[sid, cutoff, ack]
	)
	const through = row?.through == null ? null : toNumber(row.through)
	if (through === null) return (await base.gc?.()) ?? { reclaimed: 0, done: true }

	db.transactionSync(() => {
		state.feedFloor = through + 1
		state.pendingFence = { through, fencedAt: now }
		saveState(db, sid, state)
	})
	return { reclaimed: 0, done: true }
}
