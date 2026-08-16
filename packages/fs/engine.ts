/**
 * The sync engine. It is the seam's second consumer, beside the POSIX volume,
 * and its whole loop is two scans of the same feed in opposite directions:
 *
 *     pull: remote.since(cursor) → local.commit(rows)  → advance cursor
 *     push: local.since(cursor)  → remote.commit(rows) → advance cursor
 *
 * There is no journal, no snapshot session, no handoff, and no wire ordering:
 * a peer is just another `Store`, a bootstrap is `since()` from the empty
 * cursor, and rule 4 makes a row that changes mid-scan come round again rather
 * than be missed.
 *
 * Three things carry the design, and everything else here is plumbing:
 *
 * - **The author tag inside a `Version`.** Push sends only rows THIS replica
 *   authored, so a pulled row is never sent back and the steady state is
 *   silent. Idempotence is the safety net, not the traffic.
 * - **Rule 3, a row the store already holds is a no-op.** That is what makes a
 *   lost cursor, a crash, a replayed page and a fenced lineage all cost the
 *   same thing: a re-scan that writes nothing.
 * - **The cursor is host-local and always lags.** It is saved only after its
 *   batch commits, it lives in a slot the caller injects, and it never enters
 *   the replicated table or the user's tree.
 *
 * Conflicts are not here. v1 rejects and replans through guards at the
 * authority (T10), and content moves separately from rows (T9).
 */

import {
	type Cursor,
	ForeignCursorError,
	type Node,
	type Page,
	type Store,
	type Version
} from './store'

/** How many extra attempts a cycle gets before the failure becomes the caller's. */
const RETRIES = 3

/** The first backoff. Each further attempt doubles it. */
const BACKOFF_MS = 1000

/**
 * Where a replica keeps its position in a feed. The caller owns the storage —
 * `localStorage`, a table, a file — because engine state must never land in the
 * replicated table or in the user's tree, and only the host knows a place that
 * is neither.
 */
export type CursorSlot = {
	load(): Promise<Cursor | undefined>
	save(cursor: Cursor): Promise<void>
}

export type SyncOptions = {
	/** This replica's id: the author tag inside every version it mints. */
	replica: string
	/** This replica's position in the peer's feed. */
	pull: CursorSlot
	/** This replica's position in its own feed. */
	push: CursorSlot
	retries?: number
	backoffMs?: number
}

/**
 * One cycle: pull the peer's feed in, then push this replica's own rows out.
 *
 * The retries are deliberately dumb. A cursor only ever lags, so an attempt that
 * died halfway left nothing to unwind — re-running the whole cycle is both the
 * recovery and the retry, and there is no partial state to reason about.
 */
export async function sync(local: Store, remote: Store, opts: SyncOptions): Promise<void> {
	const mine = (row: Node): boolean => authorOf(row.version) === opts.replica
	const retries = opts.retries ?? RETRIES
	const backoff = opts.backoffMs ?? BACKOFF_MS
	for (let attempt = 0; ; attempt++) {
		try {
			await drain(remote, local, opts.pull)
			await drain(local, remote, opts.push, mine)
			return
		} catch (err) {
			if (attempt >= retries) throw err
			await sleep(backoff * 2 ** attempt)
		}
	}
}

/**
 * The design's `Version` — `{author, counter}` — encoded as the one opaque
 * string a store may never parse. Everything above storage reads exactly one
 * field out of it, the author, and that field is what keeps push echo-free.
 *
 * The counter is qualified by a nonce this minter draws once, because a replica
 * id is deliberately STABLE — the push filter is built on it — so two minters
 * can carry the same one: a restart, or a second volume over the same store.
 * Were their counters to line up, a version string would name two different
 * states of a row, and a version guard captured against the first would pass
 * against the second — losing exactly the concurrent update it was there to
 * catch. A clock seed does not settle this: two minters in one millisecond
 * still collide, and a clock that steps backwards re-mints a whole run.
 *
 * Chance is all that separates two minters, so the nonce keeps a whole uuid.
 * Trimming it to save bytes on a row that already carries two of them buys
 * nothing and hands the birthday bound the collision back.
 */
export function versions(replica: string): () => Version {
	const nonce = crypto.randomUUID()
	let counter = 0
	return () => `${replica}:${nonce}-${++counter}`
}

/**
 * Move one feed into one store: commit a page, THEN advance past it. The cursor
 * may lag its rows and may never lead them, which is the whole of the crash
 * story — a re-run re-applies rows the store already holds and writes nothing.
 *
 * `mine` is the push filter. Without it every pulled row would be sent back once,
 * which idempotence would absorb and the network would still pay for.
 */
async function drain(
	from: Store,
	into: Store,
	slot: CursorSlot,
	mine?: (row: Node) => boolean
): Promise<void> {
	let cursor = await slot.load()
	for (;;) {
		const page = await scan(from, cursor)
		const rows = mine ? page.nodes.filter(mine) : page.nodes
		// Nothing to send is the steady state, and an empty commit is still a round
		// trip to a peer that may be a network away.
		if (rows.length > 0) await into.commit(rows)
		// A store that hands no cursor back has broken rule 4: there is nothing to
		// resume from, so this scan is as far as the drain goes.
		if (page.next === undefined) return
		cursor = page.next
		await slot.save(cursor)
		// An empty page means caught up, and the saved cursor is where to start next.
		if (page.nodes.length === 0) return
	}
}

/**
 * One page of a feed. A cursor from a dead lineage (rule 11) is not a failure to
 * retry — no position in this store answers to it, and none ever will — so the
 * only way forward is the bootstrap scan, which converges precisely because the
 * rows it re-applies are no-ops.
 */
async function scan(from: Store, cursor?: Cursor): Promise<Page> {
	try {
		return await from.since(cursor)
	} catch (err) {
		if (!(err instanceof ForeignCursorError)) throw err
		return await from.since()
	}
}

/** The author tag: everything before the last `:`, so a replica id may hold one. */
const authorOf = (version: Version): string => {
	const cut = version.lastIndexOf(':')
	return cut === -1 ? version : version.slice(0, cut)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
