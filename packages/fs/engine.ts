/**
 * The sync engine. It is the seam's second consumer, beside the POSIX volume,
 * and its whole loop is two scans of the same feed in opposite directions:
 *
 *     push: local.since(cursor)  → remote.commit(rows) → advance cursor
 *     pull: remote.since(cursor) → local.commit(rows)  → advance cursor
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

import { type Cursor, ForeignCursorError, type Node, type Store, type Version } from './store'

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
 * One cycle: offer this replica's own rows to the peer, then take the peer's.
 *
 * Push runs FIRST, and the order is load-bearing. A pull applies rows blind —
 * there is no base to compare against, by design — so a page carrying a row's
 * older state overwrites a local edit that has not been sent yet, and the push
 * behind it skips that row because what it finds there is now the peer's.
 * Offering local work before accepting any is what keeps it. It is also the
 * order a guarded push wants: T10 replans on a rejection, which is a pull and
 * then a re-push.
 *
 * What the order does NOT cover is a write that lands mid-cycle, after the push
 * drain reaches its tail. Closing that means a pull that stops applying blind,
 * which is conflict machinery — T10's, along with the rest of it.
 *
 * The retries are deliberately dumb. A cursor only ever lags, so an attempt that
 * died halfway left nothing to unwind: re-running the cycle is both the recovery
 * and the retry.
 */
export async function sync(local: Store, remote: Store, opts: SyncOptions): Promise<void> {
	// The push filter, in a bootstrap exactly as in the steady state: to a reset
	// peer this replica restores its own work and not the rows it merely holds,
	// since a replica that re-seeded an authority with everything it had seen
	// would decide, alone and silently, whose view of the tree survives. Doing it
	// wholesale is T11's `takeMine`, which re-authors the rows first — and that
	// makes them this replica's, so this same filter carries them.
	const mine = (row: Node): boolean => authorOf(row.version) === opts.replica
	const retries = opts.retries ?? RETRIES
	const backoff = opts.backoffMs ?? BACKOFF_MS
	let rewind = false
	let failures = 0
	for (;;) {
		try {
			await drain(local, remote, opts.push, rewind, mine)
			await drain(remote, local, opts.pull, rewind)
			return
		} catch (err) {
			// Rule 11 fences the PAIR, not the cursor that threw. The two cursors are
			// one relationship — where this replica stands in the peer's feed, and what
			// it has already handed that peer — so a replaced store voids both halves,
			// and rewinding one leaves the other asserting a history the replacement
			// never had. It is not a failure to retry either, since no position in that
			// store will ever answer to that cursor: it spends no retry budget, and it
			// happens at most once, an empty cursor being one no store can fence.
			if (err instanceof ForeignCursorError && !rewind) {
				rewind = true
				continue
			}
			if (failures >= retries) throw err
			await sleep(backoff * 2 ** failures++)
		}
	}
}

/**
 * The design's `Version` — `{author, counter}` — encoded as the one opaque
 * string a store may never parse. One field of it is read above storage, the
 * author, and that field is what keeps push echo-free.
 *
 * A replica id is deliberately STABLE, so two minters can carry the same one: a
 * restart, or a second volume over the same store. Versions are compared by
 * equality and never ordered, so if their counters lined up, one string would
 * name two states of a row and a guard captured against the first would pass
 * against the second — losing the update it was there to catch. Hence a whole
 * uuid per minter, drawn once: neither a clock nor a short draw separates them.
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
 * `rewind` starts from the empty cursor and ignores the slot, which is how a
 * bootstrap and a fenced relationship are the same code path. `mine` is the push
 * filter: without it every pulled row would be sent back once, which idempotence
 * would absorb and the network would still pay for.
 */
async function drain(
	from: Store,
	into: Store,
	slot: CursorSlot,
	rewind: boolean,
	mine?: (row: Node) => boolean
): Promise<void> {
	let cursor = rewind ? undefined : await slot.load()
	for (;;) {
		const page = await from.since(cursor)
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

/** The author tag: everything before the last `:`, so a replica id may hold one. */
const authorOf = (version: Version): string => {
	const cut = version.lastIndexOf(':')
	return cut === -1 ? version : version.slice(0, cut)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
