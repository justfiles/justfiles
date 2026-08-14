/** In-memory reference adapter for experimental node-addressed sync. */

import {
	memStorage as filesystemStorage,
	type MemStorageExtension
} from '@justfiles/fs/storage/mem'
import { FileType, type Ino } from '@justfiles/fs/types'
import {
	applyNodeOperationsOver,
	type NodeJournalRow,
	type NodeState,
	type NodeStorage,
	type NodeStore,
	type NodeSyncModule,
	nodeSyncObserver,
	nodeSyncReplica
} from '../node'
import { nodeSnapshotEntries, nodeSnapshotSessions } from '../node-snapshot'

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
			const scaffold = new Set(
				[...deleted].filter((id) => states.get(id)?.type === FileType.Directory)
			)
			// Directory history remains replay scaffolding for surviving moved children.
			// Other deleted history must go so no retained page references stale content.
			for (let index = rows.length - 1; index >= 0; index--) {
				const row = rows[index]
				if (!row) continue
				const previous = row.operation.mutations
				const mutations = previous
					.filter(
						(mutation) =>
							(!deleted.has(mutation.nodeId) || scaffold.has(mutation.nodeId)) &&
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

type Exclusive = <T>(task: () => Promise<T>) => Promise<T>

function serialise(): Exclusive {
	let tail = Promise.resolve()
	return async <T>(task: () => Promise<T>): Promise<T> => {
		const previous = tail
		let release!: () => void
		tail = new Promise<void>((resolve) => {
			release = resolve
		})
		await previous
		try {
			return await task()
		} finally {
			release()
		}
	}
}

function nodeSyncExtensionOver(nodes: NodeStore, exclusive: Exclusive) {
	const observer = nodeSyncObserver(nodes)
	return {
		observer: {
			record: (port, effect, options) => exclusive(() => observer.record(port, effect, options))
		},
		attach(tree) {
			return {
				nodeSync: {
					nodes,
					apply: (operations, opts) =>
						exclusive(() => applyNodeOperationsOver(tree, nodes, operations, opts))
				}
			}
		}
	} satisfies MemStorageExtension<{ nodeSync: NodeSyncModule }>
}

/** Attach node recording and apply behavior to a memory filesystem. */
export function nodeSyncExtension(
	nodes: NodeStore
): MemStorageExtension<{ nodeSync: NodeSyncModule }> {
	return nodeSyncExtensionOver(nodes, (task) => task())
}

export function nodeMemStorage(opts?: { mintIno?: () => Ino }): NodeStorage {
	return filesystemStorage({
		mintIno: opts?.mintIno,
		extension: nodeSyncExtension(memNodeStore())
	})
}

/** Construct the snapshot-capable memory node replica through one owned adapter path. */
export function nodeMemReplica(opts?: { mintIno?: () => Ino; store?: NodeStore }) {
	const nodes = opts?.store ?? memNodeStore()
	const exclusive = serialise()
	const base = filesystemStorage({
		mintIno: opts?.mintIno,
		extension: nodeSyncExtensionOver(nodes, exclusive)
	})
	const content = base.caps?.content
	if (!content) throw new Error('memory backend exposes no content store')
	const storage: NodeStorage = {
		...base,
		caps: {
			...base.caps,
			content: {
				...content,
				gcUnreferenced: () => exclusive(() => content.gcUnreferenced())
			}
		}
	}
	const snapshots = nodeSnapshotSessions(() =>
		exclusive(async () => {
			const syncCursor = String(await nodes.head())
			const entries = nodeSnapshotEntries(await nodes.live())
			const blobs = new Map<string, Uint8Array>()
			for (const hash of new Set(
				entries.flatMap(({ mutation }) =>
					mutation.kind === 'create' && mutation.contentHash ? [mutation.contentHash] : []
				)
			)) {
				const blob = await content.getByHash(hash)
				if (!blob) throw new Error(`ENOENT: snapshot blob ${hash}`)
				blobs.set(hash, blob)
			}
			return {
				entries,
				syncCursor,
				async getBlob(hash: string) {
					const blob = blobs.get(hash)
					if (!blob) throw new Error(`ENOENT: snapshot blob ${hash}`)
					return blob.slice()
				},
				async close() {
					blobs.clear()
				}
			}
		})
	)
	const replica = nodeSyncReplica(storage, storage.nodeSync)
	return {
		storage,
		replica: {
			...replica,
			nodeSnapshot: (page?: string, snapshotOpts?: { limit?: number }) =>
				snapshots.page(page, snapshotOpts?.limit ?? 500),
			getSnapshotBlob: snapshots.getBlob,
			closeSnapshot: snapshots.close
		}
	}
}
