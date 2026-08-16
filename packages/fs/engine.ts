/**
 * The sync engine. It is the seam's second consumer, beside the POSIX volume,
 * and its whole loop is two scans of the same feed in opposite directions:
 *
 *     push: local.since(cursor)  → remote.commit(rows, bases) → advance cursor
 *     pull: remote.since(cursor) → local.commit(rows, bases)  → advance cursor
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
 * Content moves separately from the rows and is keyed by hash: `transfer` copies
 * only the bytes the other side lacks, and `lazyContent` with `hydratingBlobs`
 * lets a replica take every row and fetch bytes only when a read asks for them.
 *
 * Conflicts are v1's policy and nothing more: reject, then replan. Every commit
 * names the base it is replacing, so a conflict arrives as a refusal rather than
 * a silent overwrite, and `settle` turns each refusal into a local write the
 * next push carries — a renamed loser, a recreated file, or nothing at all.
 * `authority.ts` is what refuses; the three-way field merge the design parks for
 * later is another module over a base cache, and it changes no seam signature.
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
	type Version,
	verifiedBlobs
} from './store'

/** How many extra attempts a cycle gets before the failure becomes the caller's. */
const RETRIES = 3

/** The first backoff. Each further attempt doubles it. */
const BACKOFF_MS = 1000

/**
 * How many times a cycle may replan WITHOUT anything landing before it gives up.
 * A rejection means somebody else made progress, so this is a livelock stop
 * rather than a concurrency limit — the same reasoning as `MAX_ATTEMPTS` in the
 * volume. Counting rejections outright would be a limit: a sync wide enough to
 * meet a conflict on nine separate pages resolves every one of them and would
 * still be cut off on the ninth, so a page that lands puts the budget back.
 */
const REPLANS = 8

/**
 * Start the cycle over. Not a failure and never seen by a caller: something
 * landed locally that the peer has to be offered before the page in hand may be
 * applied over it.
 */
class Restart extends Error {
	constructor() {
		super('sync restarted: local work landed mid-cycle')
		this.name = 'Restart'
	}
}

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
	/**
	 * Take the peer's rows without its bytes: every file arrives as a stub, and
	 * `hydratingBlobs` fetches the content a read actually asks for. A pure
	 * materialization choice — the rows are identical either way, so it needs no
	 * agreement with the peer and no protocol support.
	 *
	 * Eager is the other policy, and it is a prefetch, not a promise: it moves the
	 * bytes the peer can produce WHEN the page lands. `hydratingBlobs` is what
	 * answers for the rest, at either setting.
	 */
	lazyContent?: boolean
}

/**
 * One cycle: offer this replica's own rows to the peer, then take the peer's.
 *
 * Push runs FIRST, and the order is load-bearing. A page carrying a row's older
 * state would overwrite a local edit that has not been sent yet, and the push
 * behind it would skip that row because what it finds there is now the peer's.
 * Offering local work before accepting any is what keeps it.
 *
 * Neither direction applies a page blind. Both read the rows they are about to
 * replace and guard the commit on them, so a commit that lands in between takes
 * the row and this one is refused — and a refusal is not a failure here, it is
 * the signal to read again and replan. That is the whole of v1's conflict
 * policy: reject and replan, no merges, and `settle` below is where the three
 * outcomes live.
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
	let replans = 0
	/**
	 * A buried id, and the id its content carries on under — only for revivals
	 * that actually landed. It outlives one page because a subtree wide enough to
	 * need several of them meets the same buried directory on each, and a mapping
	 * per page would stand up a second copy of it beside the first. The peer cannot
	 * be asked instead: the first copy is still only local when the next page is
	 * refused.
	 */
	const revived = new Map<NodeId, NodeId>()
	// The two directions differ only in where the bytes go, and rule 10 is why they
	// are not symmetric. Pushing, this replica may hold the only copy, so the peer
	// takes the bytes BEFORE the row that names them — a crash then leaves an orphan
	// blob instead of a row whose content was never stored. Pulling, the peer still
	// holds them, so a row may land ahead of its content and a gap is a fetch away,
	// which is what lets a lazy replica skip the fetch entirely.
	const push = async (rows: Node[]): Promise<void> => {
		await transfer(rows, local.blobs, remote.blobs)
		const guards = await bases(remote, rows)
		try {
			await remote.commit(rows, guards)
			replans = 0 // a page landed: whatever the last rejection was, it is behind us
		} catch (err) {
			// What the refusal MEANT is decided here, where the rows still are: the
			// error cannot carry them, since a peer refuses a whole batch and for
			// reasons — a taken name, a dead id — that no `Guard` states.
			if (err instanceof GuardError) await settle(local, remote, rows, opts.replica, revived)
			throw err
		}
	}
	const pull = async (rows: Node[]): Promise<void> => {
		// The base first: a local write landing after this read fails the guard
		// below, and the cycle starts again with the push, which carries it.
		const guards = await bases(local, rows)
		// One that landed BEFORE it is work the peer has never been offered — the
		// page in hand was read before that write existed, so applying it would
		// overwrite the write, and the next push would skip the row because what it
		// found there is the peer's. Hand it over, and start again on a page that
		// has it. Empty in the steady state: one local `since` that returns nothing.
		if (await drain(local, push, opts.push, false, mine)) throw new Restart()
		await local.commit(rows, guards)
		replans = 0
		// Rule 7: bytes from a peer are checked against the hash that named them
		// before they land. The peer's own store verifies what this replica pushes.
		if (!opts.lazyContent) await transfer(rows, remote.blobs, verifiedBlobs(local.blobs))
	}
	for (;;) {
		try {
			await drain(local, push, opts.push, rewind, mine)
			await drain(remote, pull, opts.pull, rewind)
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
			// A refused commit is somebody else making progress, not a peer that is
			// down, so it costs no retry and no backoff — it costs a replan. `settle`
			// has already written whatever the refusal called for, and running the
			// cycle again is what offers it. The budget is spent only on replans that
			// land nothing, since it is there to stop a livelock, not a wide sync.
			if ((err instanceof GuardError || err instanceof Restart) && replans++ < REPLANS) continue
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
 * Move one feed into one replica: apply a page, THEN advance past it. The cursor
 * may lag its rows and may never lead them, which is the whole of the crash
 * story — a re-run re-applies rows the store already holds and writes nothing.
 *
 * `rewind` starts from the empty cursor and ignores the slot, which is how a
 * bootstrap and a fenced relationship are the same code path. `mine` is the push
 * filter: without it every pulled row would be sent back once, which idempotence
 * would absorb and the network would still pay for.
 *
 * Returns how many rows it moved, which is how the pull tells "nothing to offer"
 * from "this replica wrote something the peer has not seen".
 */
async function drain(
	from: Store,
	apply: (rows: Node[]) => Promise<void>,
	slot: CursorSlot,
	rewind: boolean,
	mine?: (row: Node) => boolean
): Promise<number> {
	let cursor = rewind ? undefined : await slot.load()
	let moved = 0
	for (;;) {
		const page = await from.since(cursor)
		const rows = mine ? page.nodes.filter(mine) : page.nodes
		// Nothing to send is the steady state, and an empty commit is still a round
		// trip to a peer that may be a network away.
		if (rows.length > 0) {
			await apply(rows)
			moved += rows.length
		}
		// A store that hands no cursor back has broken rule 4: there is nothing to
		// resume from, so this scan is as far as the drain goes.
		if (page.next === undefined) return moved
		cursor = page.next
		await slot.save(cursor)
		// An empty page means caught up, and the saved cursor is where to start next.
		if (page.nodes.length === 0) return moved
	}
}

/**
 * The versions the target store holds for these rows: the base this page is
 * about to replace. A commit guarded on it is a read-modify-write — it lands
 * only if the rows are still what was read — which is what turns a conflict into
 * a rejection the engine can replan instead of a silent overwrite. `null` is
 * "not there", so a create is guarded too.
 *
 * One `get` per row. On the push that is a read at the peer, and the push filter
 * leaves the steady state with no rows at all, so the steady state still costs
 * nothing.
 */
async function bases(store: Store, rows: Node[]): Promise<Guard[]> {
	const guards: Guard[] = []
	for (const row of rows)
		guards.push({ version: { id: row.id, is: (await store.get(row.id))?.version ?? null } })
	return guards
}

/**
 * What a refused push MEANT, and what this replica does about it. v1 policy,
 * three outcomes, no merges — a field-level merge needs a base cache of
 * last-synced rows, which stays a future engine module and changes no seam type.
 *
 * The peer is the arbiter, so the peer is what gets read: asking the local store
 * would ask a replica holding two live rows for one name (rule 1) which of them
 * won, and the answer has to be the one every replica will converge on.
 *
 * Each outcome is a LOCAL write, and the push behind it needs no special path —
 * a written row moves to the end of the local feed (rule 4), so the re-scan
 * offers the fix and no longer offers what was refused. A page refused for a
 * reason none of these covers writes nothing, is offered again unchanged, and
 * after `REPLANS` of that becomes the caller's error.
 */
async function settle(
	local: Store,
	remote: Store,
	rows: Node[],
	replica: string,
	revived: Map<NodeId, NodeId>
): Promise<void> {
	// A minter per refusal, which is a minter this replica hardly ever draws. Two
	// minters for one replica are the supported case, and each draws its own nonce.
	const mint = versions(replica)
	const fixes: Node[] = []
	const guards: Guard[] = []
	/**
	 * What THIS settlement revived, held apart until its commit lands. A refused
	 * commit wrote nothing, so an id it had picked names a row that does not
	 * exist — and carrying that across the replan is worse than forgetting it: the
	 * next settlement would read the id as already dealt with, write no row for it,
	 * and go on to adopt the peer's tombstone over the content it was called to
	 * save.
	 */
	const minted = new Map<NodeId, NodeId>()

	/**
	 * Write `next`, but only while `seen` is still what the local store holds.
	 *
	 * Every row a settlement rewrites came off the feed BEFORE the push, and
	 * deciding what to do with it takes reads at the peer. A local write in that
	 * window makes it stale, and writing the rewrite blind would put the old
	 * content back under the new name — sync reporting success while the user's
	 * newest edit disappears. The guard turns that into one more refusal, which is
	 * a replan, which re-reads the row and settles it again on what is there now.
	 *
	 * `seen` is not always the row being written: a revival writes a NEW id, and
	 * what has to have held still is the row it was copied from.
	 */
	const fix = (seen: Node, next: Node): void => {
		fixes.push(next)
		guards.push({ version: { id: seen.id, is: seen.version } })
	}

	/**
	 * Where a row can actually live: its own id, if the peer still has it —
	 * otherwise a new one, standing under a new one for its parent, and so on up.
	 * The walk is what a single replacement misses: a row parented on a tombstone
	 * is refused for ever, so reviving a node without reviving the chain it hangs
	 * from just moves the refusal one level up. ROOT is never buried, so it ends.
	 *
	 * Only what this replica AUTHORED gets here, because the push filter is what
	 * built the page. That is the whole of who rescues what: this replica keeps
	 * its own work, and the peer's delete takes everything else with it.
	 */
	const living = async (id: NodeId, seen = new Set<NodeId>()): Promise<NodeId> => {
		// Rule 9 lets a replica hold a cycle mid-sync, so the walk bounds itself.
		if (id === ROOT || seen.has(id)) return id
		const already = revived.get(id) ?? minted.get(id)
		if (already !== undefined) return already
		if (!(await remote.get(id))?.deleted) return id
		const mine = await local.get(id)
		if (!mine) return id // nothing here to carry over
		seen.add(id)
		// Recorded before the walk goes up, so the id answers for itself while its own
		// ancestors are still being stood up.
		const replacement = crypto.randomUUID()
		minted.set(id, replacement)
		const parent = await living(mine.parent, seen)
		fix(mine, { ...mine, id: replacement, parent, version: mint() })
		return replacement
	}

	for (const row of rows) {
		if (row.deleted) continue // a tombstone the peer refused has nothing to save
		const theirs = await remote.get(row.id)
		if (theirs?.deleted) {
			// EDIT vs DELETE. The id is gone for good, so the content carries on under
			// a new one — this is the case a plain create cannot express, and tombstones
			// plus versions are what tell the two apart. The peer's tombstone is adopted
			// in the same commit, or the next push offers the edit again and is refused
			// again.
			await living(row.id)
			fix(row, theirs)
			continue
		}
		// The same conflict, one level out: what the peer buried is the DIRECTORY
		// this row sits in. The row itself is untouched and still perfectly good —
		// it just has nowhere to be until its container is standing again.
		if ((await remote.get(row.parent))?.deleted) {
			fix(row, { ...row, parent: await living(row.parent), version: mint() })
			continue
		}
		const holder = await remote.child(row.parent, row.name)
		// CREATE vs CREATE. Another node already holds the name at the peer, so this
		// one takes a name derived from the replica that lost — deterministic, so the
		// same conflict never needs a second round, and both files survive everywhere.
		if (holder && holder.id !== row.id)
			fix(row, { ...row, name: `${row.name} (conflict ${replica})`, version: mint() })
		// EDIT vs EDIT needs no fix. The row is still this row at the peer; what moved
		// is the base under it, and the re-push reads the new one. Last writer wins,
		// and this replica is now the last writer.
	}
	if (fixes.length === 0) return
	await local.commit(fixes, guards)
	// Landed, so these ids name real rows now and a later page may build on them.
	for (const [id, replacement] of minted) revived.set(id, replacement)
}

/**
 * Copy the bytes these rows name, and only the ones the target lacks. The `has`
 * check is what makes a rename, a copy, and a re-push after a crash cost nothing:
 * content is keyed by hash, so identical bytes are one blob wherever they appear.
 *
 * A hash the source cannot produce is skipped, not fatal, and the row travels
 * anyway: the source is lazy, or its blob was swept, and a row naming absent
 * content is a stub the seam allows. Failing instead would let one unfetchable
 * blob stop every later page from converging, for good.
 *
 * That skip is final as far as the feed is concerned. A blob write takes no feed
 * position, so a source that hydrates the hash later produces no row, and no
 * scan brings the engine back to it. Missing content is therefore recovered on
 * demand, by a read through `hydratingBlobs` — which is why an eager replica may
 * want that wrapper too. A replica that needs the bytes present whether or not
 * anything reads them wants a sweep of its own rows (`content` set, `has` false),
 * derivable from the table at any time and no business of the cycle.
 */
async function transfer(rows: Node[], from: Store['blobs'], into: Store['blobs']): Promise<void> {
	const hashes = new Set<Hash>()
	for (const row of rows) {
		// A tombstone keeps whatever fields it had, and none of them mean anything any
		// more (rule 8) — moving bytes for a dead row is pure waste.
		if (row.content !== undefined && !row.deleted) hashes.add(row.content)
	}
	for (const hash of hashes) {
		if (await into.has(hash)) continue
		const data = await from.get(hash)
		if (data !== null) await into.put(hash, data)
	}
}

/**
 * A store whose content map falls through to a peer: the demand side of selective
 * content. `sync` with `lazyContent` takes the rows only, so a file reads as a
 * row naming bytes this replica does not hold — and a read through this wrapper
 * fetches those bytes once, verifies them, and keeps them.
 *
 * It is the answer for any hash this replica lacks, not only a lazy pull: an
 * eager pull moves what the peer could produce at the time, and a peer that was
 * itself a stub then will answer for it now.
 *
 * `has` stays a local question. It answers "do I hold these bytes", which is what
 * decides a transfer; a wrapper that answered for the peer too would talk this
 * replica out of fetching anything.
 */
export function hydratingBlobs(local: Store, remote: Store): Store {
	const verified = verifiedBlobs(local.blobs)
	return {
		...local,
		blobs: {
			has: (hash) => local.blobs.has(hash),
			put: (hash, data) => local.blobs.put(hash, data),
			async get(hash) {
				const held = await local.blobs.get(hash)
				if (held !== null) return held
				const fetched = await remote.blobs.get(hash)
				// Absent on both sides is the honest answer, and the seam's: a row may
				// name content nobody holds, and a reader is told rather than guessed at.
				if (fetched === null) return null
				await verified.put(hash, fetched)
				return fetched
			}
		}
	}
}

/** The author tag: everything before the last `:`, so a replica id may hold one. */
const authorOf = (version: Version): string => {
	const cut = version.lastIndexOf(':')
	return cut === -1 ? version : version.slice(0, cut)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
