/**
 * The sync engine. It is the seam's second consumer, beside the POSIX volume,
 * and its whole loop is two scans of the same feed in opposite directions:
 *
 *     push: local.since(cursor)  → remote.commit(rows)        → advance cursor
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
 * Content moves separately from the rows and is keyed by hash: `transfer` asks the
 * other side about a blob when the bytes it may save are worth the round trip the
 * question costs, and `lazyContent` with `hydratingBlobs` lets a replica take every
 * row and fetch bytes only when a read asks for them.
 *
 * Edit conflicts are last-writer-wins at the authority. The push has no stale
 * base to name, so it does not pretend to guard one. `authority.ts` still refuses
 * tree changes that would break its rules, and `settle` turns those refusals into
 * local writes the next push carries: a renamed loser, a recreated file, or
 * nothing at all. A later three-way field merge needs a base cache and a user-facing
 * conflict policy; it changes no seam signature.
 */

import { BootstrapRequiredError, type LeasedPeer, type SyncLock, type WriteLease } from './lease'
import {
	type Cursor,
	ForeignCursorError,
	forwarded,
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

/** NUL — the one byte a name can never hold, so composed keys never collide. */
const SEP = String.fromCharCode(0)

/** How many extra attempts a cycle gets before the failure becomes the caller's. */
const RETRIES = 3

/**
 * How many of a page's per-row calls a scan keeps in flight.
 *
 * A page carries up to a hundred-odd rows. Blob transfer may need several calls per
 * hash, while pull reads each local base before it commits. Serial calls stall a
 * page and sending all of them at once makes a burst nobody asked for. A handful
 * of lanes divides the work without becoming a flood.
 */
const LANES = 8

/** The first backoff. Each further attempt doubles it. */
const BACKOFF_MS = 1000

/**
 * Bytes above which the target is ASKED whether it already holds a blob, and at or
 * under which the bytes just go.
 *
 * The probe exists to make a rename, a copy and a re-push after a crash cost nothing:
 * content is keyed by hash, so identical bytes are one blob wherever they appear. But
 * over a network the question is itself a round trip that answers with a boolean, and
 * the answer is no for every byte a replica has just written — which is most of what a
 * push carries. Paid on every blob to save the rare one, it is a latency tax on the
 * ordinary case: the whole of a small file crosses in the same round trip the question
 * would have spent, so asking first can only double it.
 *
 * Above the line the arithmetic inverts. The bytes saved grow with the file while the
 * probe stays one small request, so a renamed video is worth asking about and a
 * renamed note is not — and the note costs one round trip either way, differing only
 * in a body that rides along in packets already being sent.
 *
 * 64 KB is where a body stops being incidental to the request carrying it. It is a
 * network judgement, not a limit: nothing breaks at any value, the cost just moves.
 */
const PROBE_ABOVE = 64n * 1024n

/**
 * How many times local progress may restart a cycle without a page reaching the
 * peer. A successful page resets it; the limit only stops continuous local
 * writes from keeping one sync call alive forever.
 */
const REPLANS = 8

/**
 * Start the cycle over because local work has to be offered before the page in
 * hand may be applied over it.
 */
class Replan extends Error {
	constructor() {
		super('sync replanned after local progress')
		this.name = 'Replan'
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
	/**
	 * `undefined` is a position too — the empty cursor, where every scan starts
	 * and where a `load` that has nothing yet already answers. Saving one is how
	 * a caller says "take that feed from the top again": `takeTheirs` in
	 * `synced.ts` is the one that does, having thrown away the rows its position
	 * in the peer's feed was about.
	 */
	save(cursor: Cursor | undefined): Promise<void>
	lock?: SyncLock
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

export type SyncPeer = Store | LeasedPeer

/** Fill a hidden fresh store from a leased peer without authorising a push. */
export async function bootstrap(
	local: Store,
	remote: LeasedPeer,
	save: (cursor: Cursor) => Promise<void> = async () => {},
	start?: Cursor
): Promise<Cursor> {
	let cursor = start
	for (;;) {
		const page = await remote.since(cursor)
		if (page.nodes.length > 0) await local.commit(page.nodes)
		if (page.next === undefined) throw new Error('leased peer returned no bootstrap cursor')
		cursor = page.next
		await save(cursor)
		if (page.nodes.length === 0) {
			await remote.open(cursor)
			return cursor
		}
	}
}

/**
 * One cycle: offer this replica's own rows to the peer, then take the peer's.
 *
 * Push runs FIRST, and the order is load-bearing. A page carrying a row's older
 * state would overwrite a local edit that has not been sent yet, and the push
 * behind it would skip that row because what it finds there is now the peer's.
 * Offering local work before accepting any is what keeps it.
 *
 * The directions have different race rules. Push writes without version guards,
 * so two edits to one row are last-writer-wins at the authority. The authority may
 * still refuse a tree change; `settle` handles those refusals. Pull reads the local
 * rows it will replace and guards its commit, so a local write that lands during
 * the cycle sends the loop back through push instead of being overwritten.
 *
 * The retries are deliberately dumb. A cursor only ever lags, so an attempt that
 * died halfway left nothing to unwind: re-running the cycle is both the recovery
 * and the retry.
 */
export async function sync(local: Store, remote: SyncPeer, opts: SyncOptions): Promise<void> {
	const mine = (row: Node): boolean => authorOf(row.version) === opts.replica
	const retries = opts.retries ?? RETRIES
	const backoff = opts.backoffMs ?? BACKOFF_MS
	let failures = 0
	let replans = 0
	const peer = asLeased(remote)
	let writeLease: WriteLease | undefined
	const push = async (rows: Node[]): Promise<void> => {
		const lease = writeLease
		if (lease !== undefined && peer !== undefined) {
			await transfer(rows, local.blobs, peer.blobs, PROBE_ABOVE, (hash, data) =>
				peer.put(lease, hash, data)
			)
			await send(rows, () => peer.commit(lease, rows))
			return
		}
		const store = remote as Store
		await transfer(rows, local.blobs, store.blobs, PROBE_ABOVE, store.blobs.put)
		await send(rows, () => store.commit(rows))
	}
	const send = async (rows: Node[], commit: () => Promise<void>): Promise<void> => {
		try {
			await commit()
			replans = 0
		} catch (err) {
			if (!(err instanceof GuardError)) throw err
			let changed: boolean
			try {
				changed = await settle(local, remote, rows, opts.replica)
			} catch (settling) {
				if (settling instanceof GuardError) throw new Replan()
				throw settling
			}
			if (!changed) throw err
			throw new Replan()
		}
	}
	const pull = async (rows: Node[]): Promise<void> => {
		// The base first: a local write landing after this read fails the guard
		// below, and the cycle starts again with the push, which carries it.
		const held = await bases(local, rows)
		// Rule 3, one step before the commit rather than inside it. A version names a
		// STATE of a row — that is the whole of what makes a guard mean anything — so a
		// base equal to the row being written IS that row, already here.
		//
		// The reason to drop it here is that a store cannot: `commit` is told a batch
		// and answers nothing, so a wrapper that wakes subscribers reports the rows it
		// was HANDED, no-ops and all. Every push comes back round this feed — the peer's
		// feed carries this replica's own rows too — so the echo of a push looks to
		// `synced.ts` like fresh local work and arms another one, and no write ever
		// settles in one cycle. The rows the peer really changed are unaffected.
		const fresh: Node[] = []
		const guards: Base[] = []
		for (const [at, row] of rows.entries()) {
			const base = held[at]
			if (base === undefined || base.version.is === row.version) continue
			fresh.push(row)
			guards.push(base)
		}
		// One that landed BEFORE it is work the peer has never been offered — the
		// page in hand was read before that write existed, so applying it would
		// overwrite the write, and the next push would skip the row because what it
		// found there is the peer's. Hand it over, and start again on a page that
		// has it. Empty in the steady state: one local `since` that returns nothing.
		// A page with nothing to apply cannot overwrite anything, so it asks nothing
		// of the local feed at all.
		if (fresh.length > 0) {
			if (await drain(local, push, opts.push, mine)) throw new Replan()
			try {
				await local.commit(fresh, guards)
			} catch (err) {
				if (err instanceof GuardError) throw new Replan()
				throw err
			}
			replans = 0
		}
		// Rule 7: bytes from a peer are checked against the hash that named them
		// before they land. The peer's own store verifies what this replica pushes.
		//
		// Every hash asked about, however small: on this side the question is a local read
		// and what it saves is a download. The push's arithmetic runs the other way round.
		if (!opts.lazyContent) {
			const blobs = verifiedBlobs(local.blobs)
			await transfer(rows, remote.blobs, blobs, 0n, blobs.put)
		}
	}
	for (;;) {
		try {
			if (peer) writeLease = await peer.open(await opts.pull.load())
			try {
				await drain(local, push, opts.push, mine)
			} catch (err) {
				if (!(err instanceof ForeignCursorError) || !(await reset(opts.push, opts.pull))) throw err
				continue
			}
			try {
				await drain(remote, pull, opts.pull)
			} catch (err) {
				if (!(err instanceof ForeignCursorError) || !(await reset(opts.pull, opts.push))) throw err
				continue
			}
			return
		} catch (err) {
			if (err instanceof BootstrapRequiredError) throw err
			if (err instanceof Replan) {
				if (replans++ < REPLANS) continue
				throw err
			}
			if (err instanceof Error && err.name === 'AbortError') throw err
			if (err instanceof GuardError) throw err
			if (failures >= retries) throw err
			await sleep(backoff * 2 ** failures++)
		}
	}
}

/**
 * Clear a fenced relationship. The other half goes first, so a crash while the
 * bad cursor is cleared can only cause a replay; it cannot leave either store
 * claiming rows its replacement never saw.
 */
async function reset(fenced: CursorSlot, other: CursorSlot): Promise<boolean> {
	if ((await fenced.load()) === undefined) return false
	if (fenced.lock !== undefined && fenced.lock === other.lock) {
		await fenced.lock.run(async () => {
			await other.save(undefined)
			await fenced.save(undefined)
		})
	} else {
		await saveCursor(other, undefined)
		await saveCursor(fenced, undefined)
	}
	return true
}

export const saveCursor = (slot: CursorSlot, cursor: Cursor | undefined): Promise<void> =>
	slot.lock ? slot.lock.run(() => slot.save(cursor)) : slot.save(cursor)

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
 * A bootstrap and a fenced relationship both start from the empty cursor saved
 * in the slot. `mine` is the push filter: without it every pulled row would be
 * sent back once, which idempotence would absorb and the network would still pay
 * for.
 *
 * Returns how many rows it moved, which is how the pull tells "nothing to offer"
 * from "this replica wrote something the peer has not seen".
 */
async function drain(
	from: Pick<Store, 'since'>,
	apply: (rows: Node[]) => Promise<void>,
	slot: CursorSlot,
	mine?: (row: Node) => boolean
): Promise<number> {
	let cursor = await slot.load()
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
		await saveCursor(slot, cursor)
		// An empty page means caught up, and the saved cursor is where to start next.
		if (page.nodes.length === 0) return moved
	}
}

/**
 * The versions the local store holds for rows pulled from the peer. A commit
 * guarded on them lands only if local writes have not changed the rows since this
 * read. `null` means "not there", so a concurrent local create is guarded too.
 *
 * One local `get` per row, `LANES` of them at a time.
 */
async function bases(store: Store, rows: Node[]): Promise<Base[]> {
	return fanned(rows, async (row) => ({
		version: { id: row.id, is: (await store.get(row.id))?.version ?? null }
	}))
}

/**
 * The one guard shape a base is: a CAS on the version the target holds. Named so
 * that a caller can read `is` off it without asking which kind of guard it got —
 * the pull compares it against the row it is about to write.
 */
type Base = { version: { id: NodeId; is: Version | null } }

/**
 * Map over items with at most `LANES` calls in flight, answers in the order the
 * items came. Order is not a nicety: a guard belongs to the row at its own index,
 * and a batch whose guards slid by one would state conditions nobody meant.
 */
async function fanned<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
	const answers: R[] = Array.from({ length: items.length })
	let next = 0
	const lane = async (): Promise<void> => {
		for (let at = next++; at < items.length; at = next++) {
			const item = items[at]
			if (item !== undefined) answers[at] = await work(item)
		}
	}
	await Promise.all(Array.from({ length: Math.min(LANES, items.length) }, lane))
	return answers
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
 * reason none of these covers writes nothing and becomes the caller's error;
 * retrying the same rows immediately cannot change the peer's answer.
 */
async function settle(
	local: Store,
	remote: Pick<Store, 'get' | 'child'>,
	rows: Node[],
	replica: string
): Promise<boolean> {
	// A minter per refusal, which is a minter this replica hardly ever draws. Two
	// minters for one replica are the supported case, and each draws its own nonce.
	const mint = versions(replica)
	const fixes: Node[] = []
	const guards: Guard[] = []
	/**
	 * A buried id, and the id its content carries on under — for THIS settlement
	 * and no further. Rows share containers, so without it a page of a hundred
	 * rows would stand up a hundred copies of the one directory they all sit in.
	 *
	 * It deliberately goes no further. Carrying it between settlements bought one
	 * directory instead of two for a subtree too wide for a page, and cost two
	 * silent-loss bugs to get there — a settlement that is refused wrote nothing,
	 * so the id it picked names a row that does not exist, and the settlement after
	 * it reads that id as already dealt with and buries the content instead. The
	 * split is the honest failure: `docs` and `docs (conflict b)`, nothing lost,
	 * which is the shape v1 already ships for a name conflict.
	 */
	const revived = new Map<NodeId, NodeId>()

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

	/** Names this settlement has already given out, and nothing else can see yet. */
	const handed = new Set<string>()

	/**
	 * Rule 1's tie-break, applied to the PAGE: of two live rows claiming one
	 * `(parent, name)`, the lowest id keeps it. The rule is the stores' own, so
	 * every replica settling this page would keep the same one — and it has to be
	 * settled here, because a duplicate the peer has no part in is one the peer
	 * cannot be asked about: it answers "nobody holds that name" for both rows.
	 */
	const keeps = new Map<string, NodeId>()
	for (const row of rows) {
		if (row.deleted) continue
		const key = row.parent + SEP + row.name
		const best = keeps.get(key)
		if (best === undefined || row.id < best) keeps.set(key, row.id)
	}

	/**
	 * A name for this row that nobody holds, found in ONE settlement.
	 *
	 * Probing matters as much as the name does. Adding a suffix and letting the
	 * refusal come back would spend a replan on every name already taken, and the
	 * budget is not restored by a local rename — only by a page that reaches the
	 * peer — so a chain of them never lands at all. Both sides hold finitely many
	 * rows, so the search ends; the counter keeps the answer short, since a name
	 * that grew a suffix per collision would replicate everywhere at that length.
	 *
	 * BOTH sides, because the peer is the arbiter but cannot see what has not
	 * reached it. A name free there and taken by an unpushed row here is the one
	 * name this rename must not pick: the next push would claim it twice in one
	 * batch, the authority refuses a batch that does, and no settlement could say
	 * why — neither name is taken where it looks.
	 */
	const free = async (row: Node): Promise<string> => {
		const taken = async (name: string): Promise<boolean> => {
			// Handed to an earlier row of this same settlement, whose rename is still
			// only in `fixes` and so invisible to both stores. Rule 1 lets a replica
			// hold two live rows for one name — it says which one is VISIBLE, not that
			// it cannot happen — so one page can carry two rows losing the same name,
			// and answering both with the same new one claims it twice in one batch.
			if (handed.has(row.parent + SEP + name)) return true
			if (await remote.child(row.parent, name)) return true
			const here = await local.child(row.parent, name)
			return here !== null && here.id !== row.id
		}
		let name = `${row.name} (conflict ${replica})`
		for (let n = 2; await taken(name); n++) name = `${row.name} (conflict ${replica} ${n})`
		handed.add(row.parent + SEP + name)
		return name
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
		const already = revived.get(id)
		if (already !== undefined) return already
		if (!(await remote.get(id))?.deleted) return id
		const mine = await local.get(id)
		if (!mine) return id // nothing here to carry over
		seen.add(id)
		// Recorded before the walk goes up, so the id answers for itself while its own
		// ancestors are still being stood up.
		const replacement = crypto.randomUUID()
		revived.set(id, replacement)
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
		// CREATE vs CREATE. Another node holds the name, and WHO says so is ordered,
		// not combined: the peer decides wherever it has an opinion, and the page's
		// own tie-break answers only where the peer has none. Both at once would
		// rename the peer's own holder for losing the page and the other row for
		// losing to the peer, leaving the name to nobody.
		const holder = await remote.child(row.parent, row.name)
		const lost = holder ? holder.id !== row.id : keeps.get(row.parent + SEP + row.name) !== row.id
		// The loser takes a name derived from the replica it belongs to — so two
		// replicas conflicting over one name never pick the same answer, and every
		// file survives everywhere.
		if (lost) fix(row, { ...row, name: await free(row), version: mint() })
		// EDIT vs EDIT needs no fix. Pushes carry no version guards, so the last write
		// the authority accepts wins.
	}
	if (fixes.length === 0) return false
	await local.commit(fixes, guards)
	return true
}

/**
 * Copy the bytes these rows name, and only the ones worth asking about first. The
 * `has` check is what makes a rename, a copy, and a re-push after a crash cost
 * nothing: content is keyed by hash, so identical bytes are one blob wherever they
 * appear. `probeAbove` is where that question stops paying for itself — see the
 * constant; a target that is not across a wire wants every hash asked about, and
 * passes zero.
 *
 * The size comes off the row, which carries it denormalized for exactly this kind of
 * decision — no read, and none of the bytes crossing to find out how many there are.
 * A row that understates its content buys nothing: it can only make this replica send
 * bytes it holds anyway, and the pull side asks about every hash regardless.
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
async function transfer(
	rows: Node[],
	from: Pick<Store['blobs'], 'get'>,
	into: Pick<Store['blobs'], 'has'>,
	probeAbove: bigint,
	put: (hash: Hash, data: Uint8Array) => Promise<void>
): Promise<void> {
	const sizes = new Map<Hash, bigint>()
	for (const row of rows) {
		if (row.content !== undefined && !row.deleted) sizes.set(row.content, row.size)
	}
	await fanned([...sizes], async ([hash, size]) => {
		if (size > probeAbove && (await into.has(hash))) return
		const data = await from.get(hash)
		if (data === null) return
		await put(hash, data)
	})
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
export function hydratingBlobs(
	local: Store,
	remote: { blobs: Pick<Store['blobs'], 'get'> }
): Store {
	const verified = verifiedBlobs(local.blobs)
	return {
		...forwarded(local),
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

/**
 * The author tag: everything before the last `:`, so a replica id may hold one.
 *
 * Exported because the push filter is not its only reader. `synced.ts` asks the
 * same question of a committed row — "did I write this?" — to decide whether a
 * local write should arm a push, and answering it any other way would be a
 * second reading of the one encoding this module owns.
 */
export const authorOf = (version: Version): string => {
	const cut = version.lastIndexOf(':')
	return cut === -1 ? version : version.slice(0, cut)
}

export const isLeasedPeer = (store: SyncPeer): store is LeasedPeer => {
	const maybe = store as unknown as Record<string, unknown>
	return typeof maybe.open === 'function' && typeof maybe.put === 'function'
}

const asLeased = (store: SyncPeer): LeasedPeer | undefined =>
	isLeasedPeer(store) ? store : undefined

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
