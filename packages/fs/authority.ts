/**
 * The authority: the one `Store` whose `commit` decides what the tree is.
 *
 * Contract rule 9 puts the tree invariants here and nowhere else — no cycles, no
 * duplicate names, every parent a live directory. A replica may hold rows that
 * break all three mid-sync, and that is safe because visibility is reachability
 * from root: a detached or cyclic cluster is simply invisible until later rows
 * reattach it. What must not happen is every replica CONVERGING on such a tree,
 * and a row this wrapper refuses never enters its feed, so none of them sees it.
 *
 * Each check reads the store and then writes, so it needs those two to be one
 * step. It gets that by serializing, which is the design's own word for the
 * server: it "serializes accepted writes into its feed". A queue of one makes
 * every check below sound without adding a single guard — and guards would be
 * the worse way even where they fit, since a cycle check expressed as guards
 * puts a version guard on every ancestor of every write, turning one create deep
 * in a tree into a rejection for its neighbours.
 *
 * The wrapper is therefore the store's ONLY commit path. A writer that reaches
 * past it is outside the discipline, and nothing here could tell.
 *
 * What it does NOT do is resolve conflicts. It refuses; the engine reads again
 * and replans (`engine.ts`). That split is what keeps v1 policy — rename the
 * loser, recreate under a new id — out of the server entirely.
 */

import { GuardError, type Node, type NodeId, ROOT, type Store, verifiedBlobs } from './store'

const isDir = (row: Node): boolean => row.type === 'dir' || row.type === 'mount'

/** NUL — the one byte a name can never hold, so composed keys never collide. */
const SEP = String.fromCharCode(0)

export function authority(store: Store): Store {
	let queue: Promise<unknown> = Promise.resolve()

	return {
		...store,
		// Rule 7: this is the store that accepts writes from peers, so it is the one
		// that cannot take a caller's word for what its bytes hash to. The engine's
		// push transfers unverified for exactly this reason.
		blobs: verifiedBlobs(store.blobs),
		commit(writes, guards) {
			// One snapshot of the whole commit, checked and then written. The queue
			// puts `run` on a later microtask — behind however long every commit
			// ahead of it takes — and `check` reads the rows before the store stores
			// them, so an array the caller still owns could be edited in between and
			// the authority would pass one batch and write another. The guards travel
			// with the rows: the wrapper never reads them, but it does DELAY them, and
			// a guard edited inside that delay enforces a condition nobody stated.
			// Same reasoning as `verifiedBlobs`: a check that can be raced past is not
			// a check.
			const commit = structuredClone({ rows: writes, guards })
			const run = async (): Promise<void> => {
				await check(store, commit.rows)
				await store.commit(commit.rows, commit.guards)
			}
			const next = queue.then(run)
			// What the NEXT commit waits on is this one having finished, not having
			// worked. A rejection is the ordinary case here — it is how the authority
			// speaks — and every commit queued behind one must still run.
			queue = next.catch(() => undefined)
			return next
		}
	}
}

/**
 * Rule 9's invariants, against the state this commit is about to land on.
 *
 * Rows in the same batch count as already written. A POSIX rename replaces one
 * name with another in ONE commit, and a batch that creates a directory and its
 * first child is one too — checking each row against the store alone would
 * refuse both.
 */
async function check(store: Store, writes: Node[]): Promise<void> {
	const batch = new Map<NodeId, Node>(writes.map((row) => [row.id, row]))
	const claimed = new Map<string, NodeId>()

	for (const row of writes) {
		// A tombstone takes no name and keeps no parent: rule 8 leaves only its id,
		// its version and the fact that it is gone. It is not held to having emptied
		// itself first, either. A recursive delete is ONE commit locally and writes
		// the directory's tombstone ahead of its descendants', so a push splits the
		// two across pages — refusing a directory whose children have not caught up
		// would break `rm -r` of anything larger than a page, and would need the
		// wire ordering this model exists to delete. It is the same answer as a
		// parent that has not arrived, for the same reason (rule 9), and here the
		// children being unreachable is what the delete MEANT.
		if (row.deleted) continue
		const held = await store.get(row.id)

		// Nothing brings a dead id back. That is what tells a create on one replica
		// apart from a delete on another — the distinction Unison needs a common
		// base for — and the engine's replan is what carries the bytes forward,
		// under a new id.
		if (held?.deleted) throw new GuardError(`${row.id} is deleted, and a tombstone is final`)

		// A parent that has not arrived yet is a detached row, and rule 9 allows it.
		// It has to: the feed puts a directory AFTER the child whose creation
		// stamped it, so a paged push routinely offers children first, and refusing
		// them would need the parents-before-children wire ordering this model
		// exists to delete. A parent that IS here and is not a live directory is the
		// malformation, and no later row makes it anything else.
		const parent = row.id === ROOT ? null : (batch.get(row.parent) ?? (await store.get(row.parent)))
		if (parent && (parent.deleted || !isDir(parent)))
			throw new GuardError(`parent ${row.parent} of ${row.id} is not a live directory`)

		// The same invariant from the other end, and the only other way to break it:
		// a live directory that turns into a file leaves every row beneath it
		// parented on a non-directory. Unlike a tombstoned parent — whose children
		// the next page buries — nothing repairs this, since no writer produces a row
		// that types it back. That is also why the batch is not consulted: a volume
		// empties a directory and removes it, and a new node takes the name under a
		// new id, so nothing legitimate re-types one at all. Only a peer's raw rows
		// reach here, which is what the authority is for.
		if (held && isDir(held) && !isDir(row) && (await store.children(row.id)).nodes.length > 0)
			throw new GuardError(`${row.id} still holds children and cannot become a ${row.type}`)

		// One live row per name — within the batch, and against what is already here.
		const key = row.parent + SEP + row.name
		const twin = claimed.get(key)
		if (twin !== undefined && twin !== row.id)
			throw new GuardError(`${row.id} and ${twin} both claim ${JSON.stringify(row.name)}`)
		claimed.set(key, row.id)
		const holder = await store.child(row.parent, row.name)
		if (holder && holder.id !== row.id && !frees(batch, holder))
			throw new GuardError(`${JSON.stringify(row.name)} is taken in ${row.parent} by ${holder.id}`)

		// A cycle needs an edge that was not there before, so only a row whose parent
		// this commit sets or changes can close one — and walking up from that row
		// is what finds it. Everything else stays a read of nothing.
		if (!held || held.parent !== row.parent) await refuseCycle(store, batch, row)
	}
}

/** Does this batch move `holder` off the name it holds, or bury it? */
function frees(batch: Map<NodeId, Node>, holder: Node): boolean {
	const write = batch.get(holder.id)
	if (write === undefined) return false
	return write.deleted === true || write.parent !== holder.parent || write.name !== holder.name
}

/** Walk up from `row` — through the batch first — and refuse to arrive back at it. */
async function refuseCycle(store: Store, batch: Map<NodeId, Node>, row: Node): Promise<void> {
	const seen = new Set<NodeId>([row.id])
	let at = row.parent
	while (at !== ROOT) {
		if (seen.has(at)) throw new GuardError(`${row.id} would be its own ancestor`)
		seen.add(at)
		const up = batch.get(at) ?? (await store.get(at))
		// The chain ran out before the root: detached, which rule 9 allows, and
		// nothing above it can close a cycle.
		if (!up) return
		at = up.parent
	}
}
