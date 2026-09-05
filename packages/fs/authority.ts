/** Serialized tree checks at the authority; recovery policy belongs to the client. */

import { type SyncConflict, SyncConflictError } from './conflict.internal'

import {
	type Cursor,
	forwarded,
	type Guard,
	GuardError,
	type Node,
	type NodeId,
	ROOT,
	type Store,
	verifiedBlobs
} from './store'

/**
 * Can rows in THIS store sit beneath this one? Only a directory can, and the
 * `mount` a junction stands for is the reason this is not `volume.ts`'s
 * `isDir`, which counts one — a junction stands where a directory would, so
 * that is what it resolves and stats as.
 *
 * Here it must not. The design leans its whole local-data story on this: a
 * mount's children live in the store it is bound to, so "only a directory can
 * be a parent" is what makes a `/private` subtree impossible in the synced
 * store "on any replica, buggy or not". That boundary is enforced by the data
 * rather than by policy code, and this predicate is where the data enforces it.
 */
const holdsRows = (row: Node): boolean => row.type === 'dir'

export function authority(store: Store): Store {
	let queue: Promise<unknown> = Promise.resolve()

	return {
		...forwarded(store),
		// Rule 7: this is the store that accepts writes from peers, so it is the one
		// that cannot take a caller's word for what its bytes hash to. The engine's
		// push transfers unverified for exactly this reason.
		blobs: verifiedBlobs(store.blobs),
		commit(writes, guards) {
			// Callers retain their arrays while this commit waits in the queue.
			// Snapshot both rows and guards so the checks and write see the same input.
			const commit = structuredClone({ rows: writes, guards })
			const run = async (): Promise<void> => {
				await check(store, commit.rows, commit.guards)
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
async function check(store: Store, writes: Node[], guards: Guard[] = []): Promise<void> {
	const batch = new Map<NodeId, Node>(writes.map((row) => [row.id, row]))
	const ordered = [...writes].sort((a, b) => compare(a.id, b.id) || compare(a.version, b.version))
	const absent = new Set(
		guards.flatMap((guard) =>
			'version' in guard && guard.version.is === null ? [guard.version.id] : []
		)
	)
	// Check absence before structure: a racing arrival is a lost guard, never a deletion.
	for (const id of absent) {
		if (await store.get(id)) throw new GuardError({ version: { id, is: null } })
	}
	for (const row of ordered) {
		const facts = new Map<NodeId, Node | null>()
		const read = async (id: NodeId): Promise<Node | null> => {
			if (!facts.has(id)) facts.set(id, await store.get(id))
			return facts.get(id) ?? null
		}
		const held = await read(row.id)
		await read(row.parent)
		const conflicts: SyncConflict[] = []
		const refuse = (kind: string): void => {
			conflicts.push({
				kind,
				trigger: { id: row.id, parent: row.parent, version: row.version },
				authority: [...facts].sort(([a], [b]) => compare(a, b)).map(([id, row]) => ({ id, row }))
			})
		}
		const child = async (): Promise<Node | undefined> => {
			const found = await stranded(store, batch, row.id)
			if (found) await read(found.id)
			return found
		}
		if (row.id === ROOT && (row.deleted || !holdsRows(row) || row.parent !== ROOT)) {
			refuse('invalid-root')
			throw new SyncConflictError(conflicts[0] as SyncConflict)
		}
		if (row.deleted) {
			if (absent.has(row.id) && (await child())) refuse('settlement-has-children')
			if (conflicts[0]) throw new SyncConflictError(conflicts[0])
			continue
		}
		if (held?.deleted) refuse('deleted-id')
		const parent = row.id === ROOT ? null : (batch.get(row.parent) ?? (await read(row.parent)))
		if (parent?.deleted) refuse('deleted-parent')
		if (parent && !holdsRows(parent)) refuse('invalid-parent')
		if (!holdsRows(row) && (await child())) refuse('has-children')
		const twin = ordered.find(
			(other) =>
				other.id !== row.id &&
				!other.deleted &&
				other.parent === row.parent &&
				other.name === row.name
		)
		if (twin) {
			await read(twin.id)
			refuse('duplicate-name')
		}
		const holder = await store.child(row.parent, row.name)
		if (holder && holder.id !== row.id && !frees(batch, holder)) {
			await read(holder.id)
			refuse('taken-name')
		}
		const seen = new Set<NodeId>([row.id])
		let at = row.parent
		while (at !== ROOT) {
			if (seen.has(at)) {
				refuse('parent-cycle')
				break
			}
			seen.add(at)
			const prior = await read(at)
			const up = batch.get(at) ?? prior
			if (!up) break
			at = up.parent
		}
		const conflict = conflicts.sort((a, b) => compare(a.kind, b.kind))[0]
		if (conflict) throw new SyncConflictError(conflict)
	}
}

async function stranded(
	store: Store,
	batch: Map<NodeId, Node>,
	id: NodeId
): Promise<Node | undefined> {
	const children = new Map<NodeId, Node>()
	let cursor: Cursor | undefined
	do {
		const page = await store.children(id, cursor)
		for (const row of page.nodes) children.set(row.id, row)
		cursor = page.next
	} while (cursor !== undefined)
	for (const row of batch.values()) children.set(row.id, row)
	return [...children.values()]
		.filter((row) => row.id !== id && !row.deleted && row.parent === id)
		.sort((a, b) => compare(a.id, b.id))[0]
}

function frees(batch: Map<NodeId, Node>, holder: Node): boolean {
	const write = batch.get(holder.id)
	return (
		write !== undefined &&
		(write.deleted === true || write.parent !== holder.parent || write.name !== holder.name)
	)
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
