/**
 * The memory node-sync adapter: the REFERENCE behaviour every later node store
 * (SQLite, IndexedDB, native sidecar) must reproduce.
 *
 * It is `memStorage` with the node observer attached instead of the path one, so
 * the same filesystem records a different protocol — which is the whole point of
 * the `MutationObserver` seam.
 */

import {
	memStorage as filesystemStorage,
	type MemStorageExtension
} from '@justfiles/fs/storage/mem'
import type { Ino } from '@justfiles/fs/types'
import {
	applyNodeOperationsOver,
	type NodeJournalRow,
	type NodeMutation,
	type NodeState,
	type NodeStorage,
	type NodeStore,
	type NodeSyncModule,
	nodeSyncObserver,
	ProjectionCursorError,
	projection,
	snapshotOf
} from '../node'

/** The in-memory `NodeStore`: two indexes over one state map, plus a journal. */
export function memNodeStore(): NodeStore {
	const states = new Map<string, NodeState>()
	const byIno = new Map<Ino, string>()
	const rows: NodeJournalRow[] = []
	let seq = 0

	return {
		async get(id) {
			return states.get(id) ?? null
		},
		async idFor(ino) {
			return byIno.get(ino) ?? null
		},
		async children(parentId) {
			const out: NodeState[] = []
			for (const s of states.values()) if (s.parentId === parentId && !s.deleted) out.push(s)
			return out
		},
		// One synchronous pass: nothing can interleave, so the caller gets the state as
		// of a single instant — the consistent read a database would take in a
		// transaction.
		async live() {
			const out: NodeState[] = []
			for (const s of states.values()) if (!s.deleted) out.push(s)
			return out
		},
		async save(state) {
			const prev = states.get(state.id)
			if (prev?.localIno != null && prev.localIno !== state.localIno) byIno.delete(prev.localIno)
			states.set(state.id, state)
			if (state.localIno != null) byIno.set(state.localIno, state.id)
		},
		async append(operation, localSource) {
			seq += 1
			rows.push({ seq, operation, localSource })
		},
		async read(after, limit) {
			return rows.filter((r) => r.seq > after).slice(0, limit)
		},
		async head() {
			return seq
		}
	}
}

/**
 * Attach protocol v2 to a memory filesystem. Separate from `nodeMemStorage` so a
 * caller can compose it over its own `memStorage` — which is how the tests prove
 * the recorder and the applier never enumerate a subtree.
 */
export function nodeSyncExtension(
	nodes: NodeStore,
	ignore?: readonly string[]
): MemStorageExtension<{ nodeSync: NodeSyncModule }> {
	const view = projection(ignore)
	// One frozen ordered view per live scan. A page cut from current state could
	// miss a node a concurrent rename carried behind the keyset, and the delta that
	// follows would describe it with a `move` naming an id the reader never got.
	const scans = new Map<string, { path: string; mutation: NodeMutation }[]>()
	const SCANS_KEPT = 4
	async function snapshot(
		session: string,
		after: string,
		limit: number
	): Promise<{ path: string; mutation: NodeMutation }[]> {
		let entries = scans.get(session)
		if (!entries) {
			// A resumed page whose frozen view is gone cannot be answered consistently,
			// and answering it from current state is the very bug the freeze prevents.
			if (after !== '') throw new ProjectionCursorError()
			entries = await snapshotOf(nodes, view)
			scans.set(session, entries)
			for (const stale of [...scans.keys()].slice(0, Math.max(0, scans.size - SCANS_KEPT)))
				scans.delete(stale)
		}
		const page = entries.filter((e) => e.path > after).slice(0, limit)
		if (page.length < limit) scans.delete(session)
		return page
	}
	return {
		observer: nodeSyncObserver(nodes, view),
		attach(tree) {
			return {
				nodeSync: {
					nodes,
					view,
					snapshot,
					apply: (operations, o) => applyNodeOperationsOver(tree, nodes, view, operations, o)
				}
			}
		}
	}
}

/**
 * A memory filesystem that records protocol v2. `ignore` is the caller's own
 * never-synchronised roots — one generic list, applied in both directions.
 */
export function nodeMemStorage(opts?: {
	mintIno?: () => Ino
	ignore?: readonly string[]
}): NodeStorage {
	return filesystemStorage({
		mintIno: opts?.mintIno,
		extension: nodeSyncExtension(memNodeStore(), opts?.ignore)
	})
}
