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
			const updates = new Map(
				operation.mutations
					.filter((mutation) => mutation.kind === 'update')
					.map((mutation) => [mutation.nodeId, mutation])
			)
			const deleted = new Set(
				operation.mutations
					.filter((mutation) => mutation.kind === 'delete')
					.map((mutation) => mutation.nodeId)
			)
			// Every retained hash must survive content GC even when served on its own page.
			for (let index = rows.length - 1; index >= 0; index--) {
				const row = rows[index]
				if (!row) continue
				const previous = row.operation.mutations
				const mutations = previous
					.filter(
						(mutation) =>
							!deleted.has(mutation.nodeId) &&
							(mutation.kind !== 'update' || !updates.has(mutation.nodeId))
					)
					.map((mutation) => {
						const update = updates.get(mutation.nodeId)
						return mutation.kind === 'create' && update
							? { ...mutation, meta: update.meta, contentHash: update.contentHash }
							: mutation
					})
				if (
					mutations.length === previous.length &&
					mutations.every((mutation, mutationIndex) => mutation === previous[mutationIndex])
				)
					continue
				if (mutations.length === 0) rows.splice(index, 1)
				else rows[index] = { ...row, operation: { mutations } }
			}
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

type SnapshotEntry = { path: string; mutation: NodeMutation }

function nodeSyncExtensionOver(
	nodes: NodeStore,
	readBlob?: (hash: string) => Promise<Uint8Array | null>
): MemStorageExtension<{ nodeSync: NodeSyncModule }> {
	const scans = new Map<string, { entries: SnapshotEntry[]; blobs: Map<string, Uint8Array> }>()
	const SCANS_KEPT = 4

	async function snapshot(session: string, after: string, limit: number) {
		let scan = scans.get(session)
		if (!scan) {
			if (after !== '') throw new SnapshotCursorError()
			const entries = await snapshotOf(nodes)
			const blobs = new Map<string, Uint8Array>()
			if (readBlob)
				for (const hash of new Set(
					entries.flatMap(({ mutation }) =>
						mutation.kind === 'create' && mutation.contentHash ? [mutation.contentHash] : []
					)
				)) {
					const blob = await readBlob(hash)
					if (blob) blobs.set(hash, blob)
				}
			scan = { entries, blobs }
			scans.set(session, scan)
			for (const stale of [...scans.keys()].slice(0, Math.max(0, scans.size - SCANS_KEPT)))
				scans.delete(stale)
		}
		// Keep completed scans until bounded eviction: their final page may still fetch blobs.
		return scan.entries.filter((entry) => entry.path > after).slice(0, limit)
	}

	return {
		observer: nodeSyncObserver(nodes),
		attach(tree) {
			return {
				nodeSync: {
					nodes,
					snapshot,
					async snapshotBlob(hash) {
						for (const { blobs } of scans.values()) {
							const blob = blobs.get(hash)
							if (blob) return blob.slice()
						}
						return null
					},
					apply: (operations, opts) => applyNodeOperationsOver(tree, nodes, operations, opts)
				}
			}
		}
	}
}

/** Attach node recording and apply behavior to a memory filesystem. */
export function nodeSyncExtension(
	nodes: NodeStore
): MemStorageExtension<{ nodeSync: NodeSyncModule }> {
	return nodeSyncExtensionOver(nodes)
}

export function nodeMemStorage(opts?: { mintIno?: () => Ino }): NodeStorage {
	let readBlob = async (_hash: string): Promise<Uint8Array | null> => null
	const extension = nodeSyncExtensionOver(memNodeStore(), (hash) => readBlob(hash))
	const storage = filesystemStorage({
		mintIno: opts?.mintIno,
		extension
	})
	const content = storage.caps?.content
	if (!content) throw new Error('memory backend exposes no content store')
	readBlob = content.getByHash.bind(content)
	return storage
}
