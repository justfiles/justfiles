/**
 * Node-addressed sync (protocol v2) — experimental, beside path v1.
 *
 * Identity is a `SyncNodeId` shared by every replica. Location is
 * `parentId + name`. Each replica stores only its own `SyncNodeId <-> Ino`
 * mapping, so moving a directory is one mutation and one dirent rebind however
 * many descendants it contains.
 */

import type { Storage } from '@justfiles/fs/storage'
import type { MutationObserver, TreePort } from '@justfiles/fs/storage.shared'
import { joinPath } from '@justfiles/fs/storage.shared'
import type { Ino } from '@justfiles/fs/types'
import { FileType } from '@justfiles/fs/types'
import { z } from 'zod'
import type { SyncCursor } from './replica'
import { PAGE } from './replica'
import { ContentHash, inodeMetaFromSync, SyncMeta, syncMetaFromInode } from './wire'

// ── Identity and wire ────────────────────────────────────────────────────────

/** One logical node, shared by every replica that knows it. */
export type SyncNodeId = string

/** The well-known root identity, bound to each replica's own root inode. */
export const ROOT_NODE_ID: SyncNodeId = '00000000-0000-0000-0000-000000000000'

/** Mint the final identity before an offline create is published. */
export function newNodeId(): SyncNodeId {
	return crypto.randomUUID()
}

const nodeId = z.string().min(1)
const revision = z.number().int().nonnegative()

/** One mutation of one logical node. Local inode IDs never cross this boundary. */
export const NodeMutation = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('create'),
		nodeId,
		parentId: nodeId,
		name: z.string().min(1),
		revision,
		meta: SyncMeta,
		contentHash: ContentHash.optional()
	}),
	z.object({
		kind: z.literal('update'),
		nodeId,
		revision,
		meta: SyncMeta,
		contentHash: ContentHash.optional()
	}),
	z.object({
		kind: z.literal('move'),
		nodeId,
		parentId: nodeId,
		name: z.string().min(1),
		revision
	}),
	z.object({ kind: z.literal('delete'), nodeId, revision })
])
export type NodeMutation = z.infer<typeof NodeMutation>

/**
 * Mutations produced by one filesystem effect. Usually this contains one item;
 * replacing a live destination contains its delete followed by the move.
 */
export const NodeOperation = z.object({ mutations: z.array(NodeMutation).min(1) })
export type NodeOperation = z.infer<typeof NodeOperation>

export function mutationsOf(operations: readonly NodeOperation[]): NodeMutation[] {
	return operations.flatMap((operation) => operation.mutations)
}

// ── State and persistence seam ───────────────────────────────────────────────

/** The last accepted state of one node on this replica. */
export type NodeState = {
	id: SyncNodeId
	/** This replica's inode, or null only after deletion. */
	localIno: Ino | null
	parentId: SyncNodeId | null
	name: string
	type: FileType
	revision: number
	deleted: boolean
	meta: SyncMeta
	contentHash?: string
}

export type NodeJournalRow = {
	seq: number
	operation: NodeOperation
	/** Set for a sync-applied operation so it is not echoed back. */
	localSource?: string
}

/** The minimal node state and ordered-journal seam implemented by each adapter. */
export interface NodeStore {
	get(id: SyncNodeId): Promise<NodeState | null>
	idFor(ino: Ino): Promise<SyncNodeId | null>
	save(state: NodeState): Promise<void>
	/** Append accepted mutations while removing rows they supersede. */
	append(operation: NodeOperation, localSource?: string): Promise<void>
	read(after: number, limit: number): Promise<NodeJournalRow[]>
	head(): Promise<number>
}

/** Sync-owned seams attached to one node-addressed filesystem backend. */
export interface NodeSyncModule {
	readonly nodes: NodeStore
	apply(operations: readonly NodeOperation[], opts?: { source?: string }): Promise<void>
}

export interface NodeStorage extends Storage {
	readonly nodeSync: NodeSyncModule
}

/** Fold one accepted mutation into this replica's state. */
export function nextState(
	mutation: NodeMutation,
	previous: NodeState | null,
	localIno: Ino | null
): NodeState | null {
	if (mutation.kind === 'create')
		return {
			id: mutation.nodeId,
			localIno,
			parentId: mutation.parentId,
			name: mutation.name,
			type: mutation.meta.type,
			revision: mutation.revision,
			deleted: false,
			meta: mutation.meta,
			contentHash: mutation.contentHash
		}
	if (!previous) return null
	if (mutation.kind === 'update')
		return {
			...previous,
			localIno,
			type: mutation.meta.type,
			revision: mutation.revision,
			meta: mutation.meta,
			contentHash: mutation.contentHash
		}
	if (mutation.kind === 'move')
		return {
			...previous,
			localIno,
			parentId: mutation.parentId,
			name: mutation.name,
			revision: mutation.revision
		}
	return { ...previous, localIno: null, deleted: true, revision: mutation.revision }
}

async function bindRoot(port: TreePort, nodes: NodeStore): Promise<void> {
	if (await nodes.get(ROOT_NODE_ID)) return
	const ino = await port.resolveIno('/')
	if (ino === null) return
	const current = await port.readMetaXattrs(ino)
	await nodes.save({
		id: ROOT_NODE_ID,
		localIno: ino,
		parentId: null,
		name: '',
		type: FileType.Directory,
		revision: 0,
		deleted: false,
		meta: current
			? syncMetaFromInode(current.meta, current.xattrs)
			: { type: FileType.Directory, mode: 0o755, mtimeNs: '0', size: '0' }
	})
}

async function createMutation(
	port: TreePort,
	parentId: SyncNodeId,
	name: string,
	ino: Ino
): Promise<NodeMutation | null> {
	const current = await port.readMetaXattrs(ino)
	if (!current) return null
	const meta = syncMetaFromInode(current.meta, current.xattrs)
	return {
		kind: 'create',
		nodeId: newNodeId(),
		parentId,
		name,
		revision: 1,
		meta,
		...(current.meta.contentHash === undefined ? {} : { contentHash: current.meta.contentHash })
	}
}

async function deleteMutation(nodes: NodeStore, ino: Ino): Promise<NodeMutation | null> {
	const id = await nodes.idFor(ino)
	if (id === null) return null
	const previous = await nodes.get(id)
	if (!previous || previous.deleted) return null
	return { kind: 'delete', nodeId: id, revision: previous.revision + 1 }
}

// ── Local recording ──────────────────────────────────────────────────────────

/** Record one filesystem effect as one node-addressed journal operation. */
export function nodeSyncObserver(nodes: NodeStore): MutationObserver {
	async function commit(entries: readonly { mutation: NodeMutation; ino: Ino | null }[]) {
		if (entries.length === 0) return
		for (const { mutation, ino } of entries) {
			const previous = mutation.kind === 'create' ? null : await nodes.get(mutation.nodeId)
			const state = nextState(mutation, previous, ino)
			if (state) await nodes.save(state)
		}
		await nodes.append({ mutations: entries.map((entry) => entry.mutation) })
	}

	return {
		async record(port, effect) {
			await bindRoot(port, nodes)
			if (effect.kind === 'link') {
				const parentId = await nodes.idFor(effect.dirIno)
				if (parentId === null) return
				const mutation = await createMutation(port, parentId, effect.name, effect.ino)
				if (mutation) await commit([{ mutation, ino: effect.ino }])
				return
			}
			if (effect.kind === 'unlink') {
				const mutation = await deleteMutation(nodes, effect.ino)
				if (mutation) await commit([{ mutation, ino: null }])
				return
			}
			if (effect.kind === 'move') {
				const id = await nodes.idFor(effect.ino)
				const parentId = await nodes.idFor(effect.toDirIno)
				const previous = id === null ? null : await nodes.get(id)
				if (id === null || parentId === null || !previous) return
				const entries: { mutation: NodeMutation; ino: Ino | null }[] = []
				if (effect.displaced !== null) {
					const displaced = await deleteMutation(nodes, effect.displaced)
					if (displaced) entries.push({ mutation: displaced, ino: null })
				}
				entries.push({
					mutation: {
						kind: 'move',
						nodeId: id,
						parentId,
						name: effect.toName,
						revision: previous.revision + 1
					},
					ino: effect.ino
				})
				await commit(entries)
				return
			}

			const id = await nodes.idFor(effect.ino)
			if (id === null) return
			const previous = await nodes.get(id)
			const current = await port.readMetaXattrs(effect.ino)
			if (!previous || previous.deleted || !current) return
			const mutation: NodeMutation = {
				kind: 'update',
				nodeId: id,
				revision: previous.revision + 1,
				meta: syncMetaFromInode(current.meta, current.xattrs),
				...(current.meta.contentHash === undefined ? {} : { contentHash: current.meta.contentHash })
			}
			await commit([{ mutation, ino: effect.ino }])
		}
	}
}

// ── Remote apply ─────────────────────────────────────────────────────────────

async function emitDirent(
	port: TreePort,
	ino: Ino,
	dirIno: Ino,
	name: string,
	source?: string
): Promise<void> {
	const dirPath = await port.pathOf(dirIno)
	port.emit({
		ino,
		kind: 'dirent',
		dirIno,
		name,
		...(dirPath === null ? {} : { path: joinPath(dirPath, name) }),
		source
	})
}

async function applyMutation(
	port: TreePort,
	nodes: NodeStore,
	mutation: NodeMutation,
	source?: string
): Promise<boolean> {
	const previous = await nodes.get(mutation.nodeId)
	if (previous && (mutation.kind === 'create' || previous.revision >= mutation.revision))
		return false

	if (mutation.kind === 'create') {
		const parent = await nodes.get(mutation.parentId)
		if (parent?.localIno == null) return false
		const ino = port.mintIno()
		const state = nextState(mutation, null, ino)
		if (!state) return false
		const { meta, xattrs } = inodeMetaFromSync(mutation.meta)
		await port.upsertInode(ino, { ...meta, ctimeNs: 0n }, mutation.contentHash, xattrs)
		await port.setDirent(parent.localIno, mutation.name, ino, mutation.meta.type)
		await nodes.save(state)
		port.emit({ ino, kind: 'meta', source })
		await emitDirent(port, ino, parent.localIno, mutation.name, source)
		if (mutation.meta.type === FileType.Regular) port.emit({ ino, kind: 'content', source })
		return true
	}

	if (!previous || previous.localIno === null) return false
	if (mutation.kind === 'move') {
		const from = previous.parentId === null ? null : await nodes.get(previous.parentId)
		const to = await nodes.get(mutation.parentId)
		if (from?.localIno == null || to?.localIno == null) return false
		await port.deleteDirent(from.localIno, previous.name)
		await port.setDirent(to.localIno, mutation.name, previous.localIno, previous.type)
		const state = nextState(mutation, previous, previous.localIno)
		if (!state) return false
		await nodes.save(state)
		await emitDirent(port, previous.localIno, from.localIno, previous.name, source)
		await emitDirent(port, previous.localIno, to.localIno, mutation.name, source)
		return true
	}
	if (mutation.kind === 'delete') {
		const parent = previous.parentId === null ? null : await nodes.get(previous.parentId)
		if (parent?.localIno != null) {
			await port.deleteDirent(parent.localIno, previous.name)
			await emitDirent(port, previous.localIno, parent.localIno, previous.name, source)
		}
		await port.deleteInodeIfUnreferenced(previous.localIno)
		const state = nextState(mutation, previous, null)
		if (!state) return false
		await nodes.save(state)
		port.emit({ ino: previous.localIno, kind: 'meta', source })
		return true
	}

	const state = nextState(mutation, previous, previous.localIno)
	if (!state) return false
	const { meta, xattrs } = inodeMetaFromSync(mutation.meta)
	await port.upsertInode(previous.localIno, { ...meta, ctimeNs: 0n }, mutation.contentHash, xattrs)
	await nodes.save(state)
	port.emit({ ino: previous.localIno, kind: 'meta', source })
	if (mutation.meta.type === FileType.Regular)
		port.emit({ ino: previous.localIno, kind: 'content', source })
	return true
}

/**
 * Apply operations over an adapter's transaction-scoped tree port. Database
 * adapters call this inside one transaction; the memory reference is atomic only
 * per primitive because its filesystem has no transaction primitive.
 */
export async function applyNodeOperationsOver(
	port: TreePort,
	nodes: NodeStore,
	operations: readonly NodeOperation[],
	opts?: { source?: string }
): Promise<void> {
	await bindRoot(port, nodes)
	for (const operation of operations) {
		const accepted: NodeMutation[] = []
		for (const mutation of operation.mutations)
			if (await applyMutation(port, nodes, mutation, opts?.source)) accepted.push(mutation)
		if (accepted.length > 0) await nodes.append({ mutations: accepted }, opts?.source)
	}
}

// ── Replica ──────────────────────────────────────────────────────────────────

export interface NodeReplica {
	nodeDeltas(
		cursor: SyncCursor,
		opts?: { excludeLocalSource?: string; limit?: number }
	): Promise<{ operations: NodeOperation[]; to: SyncCursor; done: boolean }>
	applyNodeOperations(
		operations: readonly NodeOperation[],
		getBlobByHash: (hash: string) => Promise<Uint8Array>,
		opts?: { source?: string }
	): Promise<void>
	getBlobByHash(hash: string): Promise<Uint8Array>
	hasBlobByHash(hash: string): Promise<boolean>
	putBlobByHash(hash: string, data: Uint8Array): Promise<void>
}

/** A local node replica over one filesystem and its node-sync module. */
export function nodeSyncReplica(storage: Storage, sync: NodeSyncModule): NodeReplica {
	const content = () => {
		const store = storage.caps?.content
		if (!store) throw new Error('backend exposes no content store (caps.content)')
		return store
	}

	return {
		async nodeDeltas(cursor, opts) {
			const limit = opts?.limit ?? PAGE
			const from = Number(cursor || '0')
			const rows = await sync.nodes.read(from, limit)
			return {
				operations: rows
					.filter((row) => !opts?.excludeLocalSource || row.localSource !== opts.excludeLocalSource)
					.map((row) => row.operation),
				to: String(rows.at(-1)?.seq ?? from),
				done: rows.length < limit
			}
		},
		async applyNodeOperations(operations, getBlobByHash, opts) {
			const store = content()
			const wanted = new Set<string>()
			for (const mutation of mutationsOf(operations)) {
				if (mutation.kind !== 'create' && mutation.kind !== 'update') continue
				const previous = await sync.nodes.get(mutation.nodeId)
				if (previous && (mutation.kind === 'create' || previous.revision >= mutation.revision))
					continue
				if (mutation.contentHash) wanted.add(mutation.contentHash)
			}
			for (const hash of wanted)
				if (!(await store.hasByHash(hash))) await store.putByHash(hash, await getBlobByHash(hash))
			await sync.apply(operations, opts)
		},
		async getBlobByHash(hash) {
			const blob = await content().getByHash(hash)
			if (!blob) throw new Error(`ENOENT: blob ${hash}`)
			return blob
		},
		async hasBlobByHash(hash) {
			return content().hasByHash(hash)
		},
		putBlobByHash: async (hash, data) => {
			await content().putByHash(hash, data)
		}
	}
}
