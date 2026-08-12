/** In-memory reference adapter for experimental node-addressed sync. */

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
	SnapshotCursorError,
	snapshotOf
} from '../node'

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
		async live() {
			return [...states.values()].filter((state) => !state.deleted)
		},
		async save(state) {
			const previous = states.get(state.id)
			if (previous?.localIno != null && previous.localIno !== state.localIno)
				byIno.delete(previous.localIno)
			states.set(state.id, state)
			if (state.localIno != null) byIno.set(state.localIno, state.id)
		},
		async append(operation, localSource) {
			rows.push({ seq: ++seq, operation, localSource })
		},
		async read(after, limit) {
			return rows.filter((row) => row.seq > after).slice(0, limit)
		},
		async head() {
			return seq
		}
	}
}

/** Attach node recording and apply behavior to a memory filesystem. */
export function nodeSyncExtension(
	nodes: NodeStore
): MemStorageExtension<{ nodeSync: NodeSyncModule }> {
	const scans = new Map<string, { path: string; mutation: NodeMutation }[]>()
	const SCANS_KEPT = 4

	async function snapshot(session: string, after: string, limit: number) {
		let entries = scans.get(session)
		if (!entries) {
			if (after !== '') throw new SnapshotCursorError()
			entries = await snapshotOf(nodes)
			scans.set(session, entries)
			for (const stale of [...scans.keys()].slice(0, Math.max(0, scans.size - SCANS_KEPT)))
				scans.delete(stale)
		}
		const page = entries.filter((entry) => entry.path > after).slice(0, limit)
		if (page.length < limit) scans.delete(session)
		return page
	}

	return {
		observer: nodeSyncObserver(nodes),
		attach(tree) {
			return {
				nodeSync: {
					nodes,
					snapshot,
					apply: (operations, opts) => applyNodeOperationsOver(tree, nodes, operations, opts)
				}
			}
		}
	}
}

export function nodeMemStorage(opts?: { mintIno?: () => Ino }): NodeStorage {
	return filesystemStorage({
		mintIno: opts?.mintIno,
		extension: nodeSyncExtension(memNodeStore())
	})
}
