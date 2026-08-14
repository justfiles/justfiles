/**
 * Node-addressed sync (protocol v2) — experimental, beside path v1.
 *
 * Identity is a `SyncNodeId` shared by every replica. Location is
 * `parentId + name`. Each replica stores only its own `SyncNodeId <-> Ino`
 * mapping, so moving a directory is one mutation and one dirent rebind however
 * many descendants it contains.
 */

import type { ContentStore, Storage, StorageCapabilities } from '@justfiles/fs/storage'
import type { MutationObserver, TreePort } from '@justfiles/fs/storage.shared'
import { joinPath } from '@justfiles/fs/storage.shared'
import type { Ino } from '@justfiles/fs/types'
import { FileType } from '@justfiles/fs/types'
import { z } from 'zod'
import { verifyBytes } from './content'
import { acceptNodeOperations } from './node-authority'
import {
	type NodeSnapshotBlob,
	type NodeSnapshotBusy,
	type NodeSnapshotClose,
	type NodeSnapshotPage,
	type NodeSnapshotRestart,
	nodeSnapshotSessions,
	type SnapshotView
} from './node-snapshot'
import { splitPath } from './path'
import { hashIgnore, ignoredPath, normalizeIgnore } from './policy'
import type { SyncCursor } from './replica'
import { PAGE } from './replica'
import { ContentHash, inodeMetaFromSync, SyncMeta, syncMetaFromInode } from './wire'

export { nodeSnapshotEntries } from './node-snapshot'

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
const operationId = z.string().min(1)

/** One mutation of one logical node. Local inode IDs never cross this boundary. */
export const NodeMutation = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('create'),
		nodeId,
		parentId: nodeId,
		name: z.string(),
		baseRevision: z.literal(0),
		revision,
		meta: SyncMeta,
		contentHash: ContentHash.optional(),
		projection: z.literal(true).optional()
	}),
	z.object({
		kind: z.literal('update'),
		nodeId,
		baseRevision: revision,
		revision,
		meta: SyncMeta,
		contentHash: ContentHash.optional()
	}),
	z.object({
		kind: z.literal('move'),
		nodeId,
		parentId: nodeId,
		name: z.string(),
		baseRevision: revision,
		revision,
		fromParentId: nodeId.optional(),
		fromName: z.string().optional()
	}),
	z.object({
		kind: z.literal('delete'),
		nodeId,
		baseRevision: revision,
		revision,
		projection: z.literal(true).optional()
	})
])
export type NodeMutation = z.infer<typeof NodeMutation>

/**
 * Mutations produced by one filesystem effect. Usually this contains one item;
 * replacing a live destination contains its delete followed by the move.
 */
export const NodeOperation = z.object({
	operationId,
	mutations: z.array(NodeMutation).min(1),
	origin: z.string().min(1).optional(),
	boundary: z.literal(true).optional()
})
export type NodeOperation = z.infer<typeof NodeOperation>

const NodeStateSchema = z.object({
	id: nodeId,
	localIno: z.string().nullable(),
	parentId: nodeId.nullable(),
	name: z.string(),
	type: z.union([
		z.literal(FileType.Regular),
		z.literal(FileType.Directory),
		z.literal(FileType.Symlink)
	]),
	revision,
	deleted: z.boolean(),
	materialization: z.enum(['attached', 'hidden', 'blocked', 'absent']).optional(),
	meta: SyncMeta,
	contentHash: ContentHash.optional()
})
export type NodeState = z.infer<typeof NodeStateSchema>
const SharedNodeState = NodeStateSchema.omit({ localIno: true })

export const NodeOperationResult = z.union([
	z.object({ status: z.literal('accepted'), operation: NodeOperation }),
	z.discriminatedUnion('reason', [
		z.object({
			status: z.literal('rejected'),
			reason: z.literal('invalid'),
			operationId
		}),
		z.object({
			status: z.literal('rejected'),
			reason: z.literal('stale'),
			operationId,
			current: SharedNodeState
		}),
		z.object({
			status: z.literal('rejected'),
			reason: z.literal('collision'),
			operationId,
			occupant: SharedNodeState
		}),
		z.object({
			status: z.literal('rejected'),
			reason: z.literal('cycle'),
			operationId
		}),
		z.object({
			status: z.literal('rejected'),
			reason: z.literal('invalid_name'),
			operationId
		}),
		z.object({
			status: z.literal('rejected'),
			reason: z.literal('invalid_parent'),
			operationId,
			issue: z.enum(['missing', 'deleted', 'not_directory'])
		}),
		z.object({
			status: z.literal('rejected'),
			reason: z.literal('not_empty'),
			operationId
		}),
		z.object({
			status: z.literal('rejected'),
			reason: z.literal('deleted'),
			operationId,
			current: SharedNodeState
		}),
		z.object({
			status: z.literal('rejected'),
			reason: z.literal('not_found'),
			operationId
		}),
		z.object({
			status: z.literal('rejected'),
			reason: z.literal('invalid_content'),
			operationId
		}),
		z.object({
			status: z.literal('rejected'),
			reason: z.literal('missing_content'),
			operationId,
			hash: ContentHash
		})
	])
])
export type NodeOperationResult = z.infer<typeof NodeOperationResult>

export class NodeOperationRejectedError extends Error {
	constructor(readonly result: Extract<NodeOperationResult, { status: 'rejected' }>) {
		super(result.reason)
		this.name = 'NodeOperationRejectedError'
	}
}

export function newOperationId(): string {
	return crypto.randomUUID()
}

export function mutationsOf(operations: readonly NodeOperation[]): NodeMutation[] {
	return operations.flatMap((operation) => operation.mutations)
}

export type IgnoreSubscriptionPolicy = {
	readonly effectiveIgnore: readonly string[]
	readonly effectiveHash: string
	readonly identityEpoch: string
}

export class IgnoreProtocolError extends Error {
	constructor() {
		super('ignore_policy_mismatch')
		this.name = 'IgnoreProtocolError'
	}
}

export class IgnoreSubscriptionError extends Error {
	constructor() {
		super('ignore_subscription_expired')
		this.name = 'IgnoreSubscriptionError'
	}
}

export class IgnoreCursorError extends Error {
	constructor() {
		super('ignore_cursor_mismatch')
		this.name = 'IgnoreCursorError'
	}
}

/** Remove journal mutations superseded by one accepted operation. */
export function compactNodeJournal(
	rows: readonly NodeJournalRow[],
	operation: NodeOperation,
	directoryTombstones: ReadonlySet<SyncNodeId>
): NodeJournalRow[] {
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

	return rows.flatMap((row) => {
		if (row.operation.mutations.length > 1) return [row]
		const previous = row.operation.mutations
		const mutations = previous
			.filter(
				(mutation) =>
					(!deleted.has(mutation.nodeId) || directoryTombstones.has(mutation.nodeId)) &&
					(mutation.kind !== 'update' || !updates.has(mutation.nodeId))
			)
			.map((mutation) => {
				const update = updates.get(mutation.nodeId)
				return mutation.kind === 'create' && update
					? { ...mutation, meta: update.meta, contentHash: update.contentHash }
					: mutation
			})
		if (mutations.length === 0) return []
		if (
			mutations.length === previous.length &&
			mutations.every((mutation, index) => mutation === previous[index])
		)
			return [row]
		return [
			{
				...row,
				operation: { ...row.operation, operationId: newOperationId(), mutations }
			}
		]
	})
}

// ── State and persistence seam ───────────────────────────────────────────────

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
	at(parentId: SyncNodeId, name: string): Promise<NodeState | null>
	/** Every current live node; snapshot atomicity belongs to the owning adapter. */
	live(): Promise<NodeState[]>
	save(state: NodeState): Promise<void>
	remove(id: SyncNodeId): Promise<void>
	/** Append accepted mutations while removing rows they supersede. */
	append(operation: NodeOperation, localSource?: string): Promise<void>
	getOperation(
		operationId: string
	): Promise<{ request: string; result: NodeOperationResult } | null>
	saveOperation(operationId: string, request: string, result: NodeOperationResult): Promise<void>
	read(after: number, limit: number): Promise<NodeJournalRow[]>
	head(): Promise<number>
}

/** Sync-owned seams attached to one node-addressed filesystem backend. */
export interface NodeSyncModule {
	readonly nodes: NodeStore
	setLocalIgnore?(ignore: readonly string[]): void
	/** Read selected rows and their blobs in one adapter transaction. */
	captureDeltas?(
		after: number,
		limit: number,
		include: (row: NodeJournalRow) => boolean
	): Promise<{
		rows: NodeJournalRow[]
		retainedContent: ReadonlyMap<string, Uint8Array>
	}>
	apply(
		operations: readonly NodeOperation[],
		opts?: {
			source?: string
			origin?: string
			content?: ReadonlyMap<string, Uint8Array>
			ignore?: readonly string[]
		}
	): Promise<void>
	accept(
		operations: readonly NodeOperation[],
		opts?: {
			source?: string
			origin?: string
			content?: ReadonlyMap<string, Uint8Array>
			ignore?: readonly string[]
		}
	): Promise<NodeOperationResult[]>
	reconcile(
		operations: readonly NodeOperation[],
		ignore: readonly string[],
		opts?: {
			source?: string
			content?: ReadonlyMap<string, Uint8Array>
			reconcileId?: string
			preserveIds?: ReadonlySet<string>
			pendingIds?: ReadonlySet<string>
			preserveAttached?: boolean
			removeStale?: boolean
		}
	): Promise<void>
	openSnapshotView(): Promise<SnapshotView>
}

const localIgnoreRoots = new WeakMap<NodeSyncModule, readonly string[]>()

/** Optimized sync behavior attached without extending the filesystem package. */
export interface SyncCapability {
	project(ignore: readonly string[]): SyncCapability
	setLocalIgnore(ignore: readonly string[]): void
	nodeDeltas(
		cursor: SyncCursor,
		opts?: { excludeLocalSource?: string; limit?: number; retainContent?: boolean }
	): Promise<{
		operations: NodeOperation[]
		to: SyncCursor
		done: boolean
		retainedContent?: ReadonlyMap<string, Uint8Array>
	}>
	wantedContent(
		operations: readonly NodeOperation[],
		opts?: { authoritative?: boolean }
	): Promise<string[]>
	applyNodeOperations(
		operations: readonly NodeOperation[],
		opts?: { source?: string; origin?: string; content?: ReadonlyMap<string, Uint8Array> }
	): Promise<void>
	acceptNodeOperations(
		operations: readonly NodeOperation[],
		opts?: { source?: string; origin?: string; content?: ReadonlyMap<string, Uint8Array> }
	): Promise<NodeOperationResult[]>
	reconcileNodeSnapshot(
		operations: readonly NodeOperation[],
		opts?: {
			source?: string
			content?: ReadonlyMap<string, Uint8Array>
			reconcileId?: string
			preserveIds?: ReadonlySet<string>
			pendingIds?: ReadonlySet<string>
			preserveAttached?: boolean
			removeStale?: boolean
		}
	): Promise<void>
	getBlobByHash(hash: string): Promise<Uint8Array>
	nodeSnapshot(
		page?: string,
		opts?: { limit?: number }
	): Promise<NodeSnapshotPage | NodeSnapshotRestart | NodeSnapshotBusy>
	getSnapshotBlob(session: string, hash: string): Promise<NodeSnapshotBlob>
	closeSnapshot(session: string): Promise<NodeSnapshotClose>
}

/** Assemble the shared capability surface over one filesystem extension module. */
export function createSyncCapability(
	storage: Storage,
	module: NodeSyncModule,
	exclusive: <T>(task: () => Promise<T>) => Promise<T> = (task) => task(),
	ignore: readonly string[] = []
): SyncCapability {
	const roots = normalizeIgnore(ignore)
	const hidden = (path: string) => ignoredPath(roots, path)
	const snapshots = nodeSnapshotSessions(async () => {
		const view = await module.openSnapshotView()
		if (roots.length === 0) return view
		const entries = view.entries.filter((entry) => !hidden(entry.path))
		const hashes = new Set(
			entries.flatMap(({ mutation }) =>
				mutation.kind === 'create' && mutation.contentHash ? [mutation.contentHash] : []
			)
		)
		return {
			...view,
			entries,
			getBlob(hash: string) {
				if (!hashes.has(hash)) throw new Error(`ENOENT: snapshot blob ${hash}`)
				return view.getBlob(hash)
			}
		}
	})
	const content = storage.caps?.content

	async function mutationPath(mutation: NodeMutation): Promise<string | null> {
		if (mutation.kind === 'create' || mutation.kind === 'move') {
			const parent = await module.nodes.get(mutation.parentId)
			const parentPath = parent ? await storedPath(module.nodes, parent) : null
			return parentPath === null ? null : joinPath(parentPath, mutation.name)
		}
		const state = await module.nodes.get(mutation.nodeId)
		return state ? storedPath(module.nodes, state) : null
	}

	async function relativeTo(node: NodeState, ancestorId: SyncNodeId): Promise<string | null> {
		const names: string[] = []
		const seen = new Set<string>()
		let current: NodeState | null = node
		while (current && current.id !== ancestorId) {
			if (seen.has(current.id) || current.parentId === null) return null
			seen.add(current.id)
			names.unshift(current.name)
			current = await module.nodes.get(current.parentId)
		}
		return current ? `/${names.join('/')}` : null
	}

	async function visibleOperations(
		operations: readonly NodeOperation[],
		incoming = false
	): Promise<NodeOperation[]> {
		if (roots.length === 0) return [...operations]
		const visible: NodeOperation[] = []
		const stagedPaths = new Map<string, string>()
		// /.state belongs to the sync engine, not to a peer's effective policy.
		const localRoots = (localIgnoreRoots.get(module) ?? []).filter((root) => root !== '/.state')
		const projectedRoots = roots.filter((root) => root !== '/.state')
		const localProjection =
			localRoots.length === projectedRoots.length &&
			localRoots.every((root, index) => root === projectedRoots[index])
		for (const operation of operations) {
			const mutations: NodeMutation[] = []
			const authoredMove = operation.mutations.find(
				(mutation): mutation is Extract<NodeMutation, { kind: 'move' }> =>
					mutation.kind === 'move' && mutation.fromParentId !== undefined
			)
			const authoredFromParent = authoredMove?.fromParentId
				? await module.nodes.get(authoredMove.fromParentId)
				: null
			const authoredFromParentPath = authoredFromParent
				? await storedPath(module.nodes, authoredFromParent)
				: null
			const authoredFromPath =
				authoredMove?.fromName && authoredFromParentPath !== null
					? joinPath(authoredFromParentPath, authoredMove.fromName)
					: null
			const projected =
				(operation.boundary === true && (incoming || localProjection)) ||
				operation.mutations.some((mutation) => 'projection' in mutation && mutation.projection)
			const created = new Set(
				operation.mutations
					.filter((mutation) => mutation.kind === 'create')
					.map((mutation) => mutation.nodeId)
			)
			for (const mutation of operation.mutations) {
				if (
					mutation.kind === 'move' &&
					mutation.fromParentId !== undefined &&
					mutation.fromName !== undefined
				) {
					const fromParent = await module.nodes.get(mutation.fromParentId)
					const toParent = await module.nodes.get(mutation.parentId)
					const fromParentPath = fromParent ? await storedPath(module.nodes, fromParent) : null
					const toParentPath = toParent ? await storedPath(module.nodes, toParent) : null
					if (fromParentPath === null || toParentPath === null) continue
					const fromPath = joinPath(fromParentPath, mutation.fromName)
					const toPath = joinPath(toParentPath, mutation.name)
					if (projected) {
						if (!hidden(fromPath) && !hidden(toPath)) {
							mutations.push(mutation)
							stagedPaths.set(mutation.nodeId, toPath)
						}
						continue
					}
					if (
						hidden(fromPath) === hidden(toPath) &&
						!roots.some((root) => root.startsWith(`${fromPath}/`) || root.startsWith(`${toPath}/`))
					) {
						if (!hidden(fromPath) && !hidden(toPath)) {
							mutations.push(mutation)
							stagedPaths.set(mutation.nodeId, toPath)
						}
						continue
					}
					const transitions: Array<{
						node: NodeState
						fromHidden: boolean
						toHidden: boolean
						path: string
					}> = []
					for (const node of await module.nodes.live()) {
						if (created.has(node.id)) continue
						const relative = await relativeTo(node, mutation.nodeId)
						if (relative === null) continue
						const oldPath = fromPath + relative
						const path = toPath + relative
						transitions.push({
							node,
							fromHidden: hidden(oldPath),
							toHidden: hidden(path),
							path
						})
					}
					for (const entry of transitions
						.filter(({ fromHidden, toHidden }) => !fromHidden && toHidden)
						.sort((a, b) => b.path.length - a.path.length))
						mutations.push({
							kind: 'delete',
							nodeId: entry.node.id,
							baseRevision:
								entry.node.id === mutation.nodeId ? mutation.baseRevision : entry.node.revision,
							revision: entry.node.id === mutation.nodeId ? mutation.revision : entry.node.revision,
							projection: true
						})
					if (!hidden(fromPath) && !hidden(toPath)) {
						mutations.push(mutation)
						stagedPaths.set(mutation.nodeId, toPath)
					}
					for (const entry of transitions
						.filter(({ fromHidden, toHidden }) => fromHidden && !toHidden)
						.sort((a, b) => a.path.length - b.path.length))
						mutations.push({
							kind: 'create',
							nodeId: entry.node.id,
							parentId: entry.node.parentId as SyncNodeId,
							name: entry.node.name,
							baseRevision: 0,
							revision: entry.node.revision,
							meta: entry.node.meta,
							...(entry.node.contentHash ? { contentHash: entry.node.contentHash } : {}),
							projection: true
						})
					continue
				}
				let path: string | null
				if (mutation.kind === 'create' || mutation.kind === 'move') {
					const stagedParent = stagedPaths.get(mutation.parentId)
					if (stagedParent !== undefined) path = joinPath(stagedParent, mutation.name)
					else path = await mutationPath(mutation)
					if (path !== null) stagedPaths.set(mutation.nodeId, path)
				} else {
					path = stagedPaths.get(mutation.nodeId) ?? null
					if (path === null && mutation.kind === 'delete' && authoredMove && authoredFromPath) {
						const state = await module.nodes.get(mutation.nodeId)
						const relative = state ? await relativeTo(state, authoredMove.nodeId) : null
						if (relative !== null) path = authoredFromPath + relative
					}
					if (path === null) path = await mutationPath(mutation)
				}
				if (path !== null && !hidden(path)) mutations.push(mutation)
			}
			if (mutations.length > 0) visible.push({ ...operation, mutations })
		}
		return visible
	}

	async function readLiveBlob(hash: string): Promise<Uint8Array> {
		for (const node of await module.nodes.live()) {
			if (node.contentHash !== hash || node.localIno === null) continue
			const path = await storedPath(module.nodes, node)
			if (path === null || hidden(path)) continue
			const blob = content ? await content.getByHash(hash) : await storage.getBlob(node.localIno)
			if (!blob) throw new Error(`ENOENT: blob ${hash}`)
			return verifyBytes(hash, blob)
		}
		throw new Error(`ENOENT: blob ${hash}`)
	}

	return {
		project: (nextIgnore) => createSyncCapability(storage, module, exclusive, nextIgnore),
		setLocalIgnore(nextIgnore) {
			const roots = normalizeIgnore(nextIgnore)
			localIgnoreRoots.set(module, roots)
			module.setLocalIgnore?.(roots)
		},
		nodeDeltas: (cursor, opts) =>
			exclusive(async () => {
				const limit = opts?.limit ?? PAGE
				const from = Number(cursor || '0')
				const include = (row: NodeJournalRow) =>
					!opts?.excludeLocalSource || row.localSource !== opts.excludeLocalSource
				const captured =
					opts?.retainContent && module.captureDeltas
						? await module.captureDeltas(from, limit, include)
						: undefined
				const rows = captured?.rows ?? (await module.nodes.read(from, limit))
				const operations = await visibleOperations(rows.filter(include).map((row) => row.operation))
				let retainedContent = captured ? new Map(captured.retainedContent) : undefined
				if (opts?.retainContent && !retainedContent) {
					retainedContent = new Map()
					for (const mutation of mutationsOf(operations)) {
						if (mutation.kind !== 'create' && mutation.kind !== 'update') continue
						const hash = mutation.contentHash
						if (!hash || retainedContent.has(hash)) continue
						const blob = await readLiveBlob(hash)
						retainedContent.set(hash, blob.slice())
					}
				}
				return {
					operations,
					to: String(rows.at(-1)?.seq ?? from),
					done: rows.length < limit,
					...(retainedContent ? { retainedContent } : {})
				}
			}),
		async wantedContent(operations, opts) {
			const wanted = new Set<string>()
			for (const operation of await visibleOperations(operations, true)) {
				if (opts?.authoritative && (await module.nodes.getOperation(operation.operationId)))
					continue
				for (const mutation of operation.mutations) {
					if (mutation.kind !== 'create' && mutation.kind !== 'update') continue
					if (!opts?.authoritative) {
						const previous = await module.nodes.get(mutation.nodeId)
						if (
							previous &&
							((mutation.kind === 'create' && !mutation.projection) ||
								(mutation.kind !== 'create' && previous.revision >= mutation.revision))
						)
							continue
					}
					if (mutation.contentHash) wanted.add(mutation.contentHash)
				}
			}
			return [...wanted]
		},
		applyNodeOperations: async (operations, opts) =>
			module.apply(await visibleOperations(operations, true), { ...opts, ignore: roots }),
		reconcileNodeSnapshot: (operations, opts) => module.reconcile(operations, roots, opts),
		async acceptNodeOperations(operations, opts) {
			if (roots.length === 0) return module.accept(operations, opts)
			const results: NodeOperationResult[] = []
			for (const operation of operations) {
				const [visible] = await visibleOperations([operation], true)
				if (!visible || visible.mutations.length !== operation.mutations.length) {
					results.push({
						status: 'rejected',
						reason: 'invalid',
						operationId: operation.operationId
					})
					continue
				}
				results.push(...(await module.accept([operation], { ...opts, ignore: roots })))
			}
			return results
		},
		getBlobByHash: readLiveBlob,
		nodeSnapshot: (page, opts) => snapshots.page(page, opts?.limit ?? PAGE),
		getSnapshotBlob: (session, hash) => snapshots.getBlob(session, hash),
		closeSnapshot: (session) => snapshots.close(session)
	}
}

/** Attach a sync-owned capability while keeping the filesystem type unchanged. */
export function withSyncCapability<T extends Storage>(
	storage: T,
	sync: SyncCapability
): T & SyncCapableStorage {
	return Object.assign(storage, { caps: { ...storage.caps, sync } })
}

/** A filesystem whose optional sync accelerator was assembled by `packages/sync`. */
export type SyncCapableStorage = Storage & {
	readonly caps: StorageCapabilities & { readonly sync: SyncCapability }
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
			materialization: localIno === null ? 'absent' : 'attached',
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
	if (mutation.projection)
		return {
			...previous,
			localIno: null,
			materialization: 'hidden',
			revision: mutation.revision
		}
	return {
		...previous,
		localIno: null,
		deleted: true,
		materialization: 'absent',
		revision: mutation.revision
	}
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
	ino: Ino,
	nodeId = newNodeId()
): Promise<NodeMutation | null> {
	const current = await port.readMetaXattrs(ino)
	if (!current) return null
	const meta = syncMetaFromInode(current.meta, current.xattrs)
	return {
		kind: 'create',
		nodeId,
		parentId,
		name,
		baseRevision: 0,
		revision: 1,
		meta,
		...(current.meta.contentHash === undefined ? {} : { contentHash: current.meta.contentHash })
	}
}

async function deleteMutation(
	nodes: NodeStore,
	ino: Ino,
	expected?: { parentId: SyncNodeId; name: string }
): Promise<NodeMutation | null> {
	const id = await nodes.idFor(ino)
	if (id === null) return null
	const previous = await nodes.get(id)
	if (
		!previous ||
		previous.deleted ||
		(expected && !atLocation(previous, expected.parentId, expected.name))
	)
		return null
	return {
		kind: 'delete',
		nodeId: id,
		baseRevision: previous.revision,
		revision: previous.revision + 1
	}
}

function atLocation(node: NodeState, parentId: SyncNodeId, name: string): boolean {
	return node.parentId === parentId && node.name === name
}

async function storedPath(nodes: NodeStore, node: NodeState): Promise<string | null> {
	const names: string[] = []
	const seen = new Set<string>()
	let current: NodeState | null = node
	while (current && current.id !== ROOT_NODE_ID) {
		if (seen.has(current.id) || current.parentId === null) return null
		seen.add(current.id)
		names.unshift(current.name)
		current = await nodes.get(current.parentId)
	}
	return current?.id === ROOT_NODE_ID ? `/${names.join('/')}` : null
}

// ── Local recording ──────────────────────────────────────────────────────────

/** Record one filesystem effect as one node-addressed journal operation. */
export function nodeSyncObserver(
	nodes: NodeStore,
	ignore: () => readonly string[] = () => []
): MutationObserver {
	type Entry = { mutation: NodeMutation; ino: Ino | null }
	async function commit(entries: readonly Entry[], boundary = false) {
		if (entries.length === 0) return
		for (const { mutation, ino } of entries) {
			const previous = mutation.kind === 'create' ? null : await nodes.get(mutation.nodeId)
			const state = nextState(mutation, previous, ino)
			if (state) await nodes.save(state)
		}
		await nodes.append({
			operationId: newOperationId(),
			mutations: entries.map((entry) => entry.mutation),
			...(boundary ? { boundary: true } : {})
		})
	}

	return {
		async record(port, effect) {
			await bindRoot(port, nodes)
			const pathAt = async (dirIno: Ino, name: string): Promise<string | null> => {
				const dirPath = await port.pathOf(dirIno)
				return dirPath === null ? null : joinPath(dirPath, name)
			}
			if (effect.kind === 'link') {
				const path = await pathAt(effect.dirIno, effect.name)
				if (path === null || ignoredPath(ignore(), path)) return
				// putDirent can add a hard link, but node sync tracks one name per inode.
				if ((await nodes.idFor(effect.ino)) !== null) return
				const parentId = await nodes.idFor(effect.dirIno)
				if (parentId === null) return
				const mutation = await createMutation(port, parentId, effect.name, effect.ino)
				if (mutation) await commit([{ mutation, ino: effect.ino }])
				return
			}
			if (effect.kind === 'unlink') {
				const path = await pathAt(effect.dirIno, effect.name)
				if (path === null || ignoredPath(ignore(), path)) return
				const parentId = await nodes.idFor(effect.dirIno)
				if (parentId === null) return
				const mutation = await deleteMutation(nodes, effect.ino, {
					parentId,
					name: effect.name
				})
				if (mutation) await commit([{ mutation, ino: null }])
				return
			}
			if (effect.kind === 'move') {
				const fromPath = await pathAt(effect.fromDirIno, effect.fromName)
				const toPath = await pathAt(effect.toDirIno, effect.toName)
				if (fromPath === null || toPath === null) return
				const roots = ignore()
				const fromIgnored = ignoredPath(roots, fromPath)
				const toIgnored = ignoredPath(roots, toPath)
				if (fromIgnored && toIgnored) return
				const subtree =
					fromIgnored !== toIgnored ||
					roots.some((root) => root.startsWith(`${fromPath}/`) || root.startsWith(`${toPath}/`))
						? await port.enumerateSubtree(effect.ino)
						: undefined
				const deletes = async (include: (oldPath: string, newPath: string) => boolean) => {
					const entries: Entry[] = []
					for (const entry of [...(subtree ?? [])].sort((a, b) => b.rel.length - a.rel.length)) {
						if (!include(fromPath + entry.rel, toPath + entry.rel)) continue
						const mutation = await deleteMutation(nodes, entry.ino)
						if (mutation) entries.push({ mutation, ino: null })
					}
					return entries
				}
				const creates = async (include: (oldPath: string, newPath: string) => boolean) => {
					const entries: Entry[] = []
					const fresh = new Map<Ino, SyncNodeId>()
					for (const entry of [...(subtree ?? [])].sort((a, b) => a.rel.length - b.rel.length)) {
						const oldPath = fromPath + entry.rel
						const newPath = toPath + entry.rel
						if (!include(oldPath, newPath)) continue
						const { parentPath, name } = splitPath(newPath)
						const parentIno = await port.resolveIno(parentPath)
						const parentId =
							parentIno === null ? null : (fresh.get(parentIno) ?? (await nodes.idFor(parentIno)))
						if (parentId === null) continue
						const mutation = await createMutation(port, parentId, name, entry.ino)
						if (!mutation) continue
						fresh.set(entry.ino, mutation.nodeId)
						entries.push({ mutation, ino: entry.ino })
					}
					return entries
				}
				if (!fromIgnored && toIgnored) {
					await commit(await deletes(() => true), true)
					return
				}
				const parentId = await nodes.idFor(effect.toDirIno)
				if (parentId === null) return
				const entries: Entry[] = []
				if (effect.displaced !== null) {
					const displaced = await deleteMutation(nodes, effect.displaced, {
						parentId,
						name: effect.toName
					})
					if (displaced) entries.push({ mutation: displaced, ino: null })
				}
				if (fromIgnored) {
					entries.push(...(await creates((_oldPath, newPath) => !ignoredPath(roots, newPath))))
					await commit(entries, true)
					return
				}
				const id = await nodes.idFor(effect.ino)
				const sourceParentId = await nodes.idFor(effect.fromDirIno)
				const previous = id === null ? null : await nodes.get(id)
				if (
					id === null ||
					sourceParentId === null ||
					!previous ||
					!atLocation(previous, sourceParentId, effect.fromName)
				) {
					await commit(entries)
					return
				}
				if (subtree)
					entries.push(
						...(await deletes(
							(oldPath, newPath) => !ignoredPath(roots, oldPath) && ignoredPath(roots, newPath)
						))
					)
				entries.push({
					mutation: {
						kind: 'move',
						nodeId: id,
						parentId,
						name: effect.toName,
						fromParentId: sourceParentId,
						fromName: effect.fromName,
						baseRevision: previous.revision,
						revision: previous.revision + 1
					},
					ino: effect.ino
				})
				if (subtree)
					entries.push(
						...(await creates(
							(oldPath, newPath) => ignoredPath(roots, oldPath) && !ignoredPath(roots, newPath)
						))
					)
				await commit(entries, subtree !== undefined)
				return
			}

			const id = await nodes.idFor(effect.ino)
			if (id === null) return
			const path = await port.pathOf(effect.ino)
			if (path === null || ignoredPath(ignore(), path)) return
			const previous = await nodes.get(id)
			const current = await port.readMetaXattrs(effect.ino)
			if (!previous || previous.deleted || !current) return
			const mutation: NodeMutation = {
				kind: 'update',
				nodeId: id,
				baseRevision: previous.revision,
				revision: previous.revision + 1,
				meta: syncMetaFromInode(current.meta, current.xattrs),
				...(current.meta.contentHash === undefined ? {} : { contentHash: current.meta.contentHash })
			}
			await commit([{ mutation, ino: effect.ino }])
		}
	}
}

export async function reconcileNodeSnapshotOver(
	port: TreePort,
	nodes: NodeStore,
	operations: readonly NodeOperation[],
	ignore: readonly string[],
	opts?: {
		source?: string
		content?: ReadonlyMap<string, Uint8Array>
		reconcileId?: string
		preserveIds?: ReadonlySet<string>
		pendingIds?: ReadonlySet<string>
		preserveAttached?: boolean
		removeStale?: boolean
	}
): Promise<void> {
	await bindRoot(port, nodes)
	const hidden = (path: string) => ignoredPath(ignore, path)

	const oldByPath = new Map<string, NodeState>()
	for (const node of await nodes.live()) {
		if (node.id === ROOT_NODE_ID) continue
		const path = await storedPath(nodes, node)
		if (path === null) continue
		oldByPath.set(path, node)
		if (hidden(path) && node.localIno !== null)
			await nodes.save({ ...node, localIno: null, materialization: 'hidden' })
	}

	const remotePaths = new Map<string, string>([[ROOT_NODE_ID, '/']])
	const remoteEntries: Array<{
		path: string
		mutation: Extract<NodeMutation, { kind: 'create' }>
	}> = []
	for (const mutation of mutationsOf(operations)) {
		if (mutation.kind !== 'create') continue
		const parentPath = remotePaths.get(mutation.parentId)
		if (parentPath === undefined) continue
		const path = joinPath(parentPath, mutation.name)
		remotePaths.set(mutation.nodeId, path)
		remoteEntries.push({ path, mutation })
	}

	async function removeTree(path: string, ino: Ino): Promise<boolean> {
		const subtree = await port.enumerateSubtree(ino)
		if (subtree.some((entry) => entry.rel !== '' && hidden(path + entry.rel))) return false
		for (const entry of [...subtree].sort((a, b) => b.rel.length - a.rel.length)) {
			const fullPath = path + entry.rel
			const { parentPath, name } = splitPath(fullPath)
			const parentIno = await port.resolveIno(parentPath)
			if (parentIno !== null) await port.deleteDirent(parentIno, name)
			const id = await nodes.idFor(entry.ino)
			if (id !== null) await nodes.remove(id)
			await port.deleteInodeIfUnreferenced(entry.ino)
		}
		return true
	}

	for (const { path, mutation } of remoteEntries) {
		if (hidden(path)) continue
		const parent = await nodes.get(mutation.parentId)
		const state = nextState(mutation, null, null)
		if (!state) continue
		if (parent?.localIno == null) {
			await nodes.save({ ...state, materialization: 'absent' })
			continue
		}

		let ino = await port.resolveIno(path)
		if (ino !== null) {
			const current = await port.readMetaXattrs(ino)
			if (!current) ino = null
			else if (current.meta.type !== mutation.meta.type) {
				if (!(await removeTree(path, ino))) {
					await nodes.save({ ...state, materialization: 'blocked' })
					continue
				}
				ino = null
			}
		}

		if (ino === null) {
			await nodes.remove(mutation.nodeId)
			await applyMutation(port, nodes, mutation, opts)
			continue
		}

		const mapped = await nodes.idFor(ino)
		if (mapped !== null && mapped !== mutation.nodeId) await nodes.remove(mapped)
		const old = oldByPath.get(path)
		if (old && old.id !== mutation.nodeId) await nodes.remove(old.id)
		const { meta, xattrs } = inodeMetaFromSync(mutation.meta)
		await port.upsertInode(
			ino,
			{ ...meta, ctimeNs: 0n },
			mutation.contentHash,
			xattrs,
			mutation.contentHash === undefined ? undefined : opts?.content?.get(mutation.contentHash)
		)
		await nodes.save({ ...state, localIno: ino, materialization: 'attached' })
		port.emit({ ino, kind: 'meta', source: opts?.source })
		if (mutation.meta.type === FileType.Regular)
			port.emit({ ino, kind: 'content', source: opts?.source })
	}

	const rootIno = await port.resolveIno('/')
	if (rootIno === null) return
	const remotePathSet = new Set(remoteEntries.map((entry) => entry.path))
	const protectedScaffolds = new Set<string>()
	if (opts?.removeStale) {
		const staleEntries = await port.enumerateSubtree(rootIno)
		for (const entry of staleEntries.sort((a, b) => b.rel.length - a.rel.length)) {
			if (!entry.rel || hidden(entry.rel) || remotePathSet.has(entry.rel)) continue
			const id = await nodes.idFor(entry.ino)
			if (id === null || opts.pendingIds?.has(id)) continue
			const state = await nodes.get(id)
			if (!state) continue
			const current = await port.readMetaXattrs(entry.ino)
			if (current?.meta.type === FileType.Directory && (await port.dirHasLiveChildren(entry.ino))) {
				await nodes.save({
					...state,
					localIno: null,
					deleted: true,
					materialization: 'blocked'
				})
				protectedScaffolds.add(entry.rel)
				continue
			}
			const { parentPath, name } = splitPath(entry.rel)
			const parentIno = await port.resolveIno(parentPath)
			if (parentIno !== null) await port.deleteDirent(parentIno, name)
			await nodes.remove(id)
			await port.deleteInodeIfUnreferenced(entry.ino)
		}
	}

	const localEntries = await port.enumerateSubtree(rootIno)
	const creates: Array<{ mutation: NodeMutation; ino: Ino }> = []
	for (const entry of [...localEntries].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
		if (!entry.rel) continue
		const path = entry.rel
		if (hidden(path) || remotePathSet.has(path) || protectedScaffolds.has(path)) continue
		const { parentPath, name } = splitPath(path)
		const parentIno = await port.resolveIno(parentPath)
		const parentId = parentIno === null ? null : await nodes.idFor(parentIno)
		if (parentId === null) continue
		const mapped = await nodes.idFor(entry.ino)
		if (mapped !== null && opts?.preserveIds?.has(mapped)) continue
		if (mapped !== null && opts?.preserveAttached) {
			const state = await nodes.get(mapped)
			if (state?.localIno !== null) continue
		}
		const nodeId = opts?.reconcileId ? `${opts.reconcileId}:${path}` : newNodeId()
		if (mapped === nodeId) continue
		if (mapped !== null) await nodes.remove(mapped)
		const old = oldByPath.get(path)
		if (old) await nodes.remove(old.id)
		const mutation = await createMutation(port, parentId, name, entry.ino, nodeId)
		if (!mutation) continue
		const state = nextState(mutation, null, entry.ino)
		if (!state) continue
		await nodes.save(state)
		creates.push({ mutation, ino: entry.ino })
	}
	for (const entry of creates)
		await nodes.append({
			operationId: opts?.reconcileId
				? `${opts.reconcileId}:${entry.mutation.nodeId}`
				: newOperationId(),
			mutations: [entry.mutation]
		})
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
	opts?: {
		source?: string
		content?: ReadonlyMap<string, Uint8Array>
		ignore?: readonly string[]
	}
): Promise<boolean> {
	const previous = await nodes.get(mutation.nodeId)
	const reattach =
		mutation.kind === 'create' &&
		mutation.projection === true &&
		previous !== null &&
		!previous.deleted &&
		previous.localIno === null
	if (
		previous &&
		((mutation.kind === 'create' && !reattach) ||
			(mutation.kind !== 'create' &&
				(!('projection' in mutation) || !mutation.projection) &&
				previous.revision >= mutation.revision))
	)
		return false

	if (mutation.kind === 'create') {
		const parent = await nodes.get(mutation.parentId)
		if (parent?.localIno == null) return false
		const parentPath = await storedPath(nodes, parent)
		const path = parentPath === null ? null : joinPath(parentPath, mutation.name)
		const canProtect =
			path !== null && (opts?.ignore ?? []).some((root) => root.startsWith(`${path}/`))
		const existing = canProtect ? await port.getDirent(parent.localIno, mutation.name) : null
		const protectedChild =
			path !== null &&
			existing !== null &&
			(await port.enumerateSubtree(existing.ino)).some(
				(entry) => entry.rel !== '' && ignoredPath(opts?.ignore ?? [], path + entry.rel)
			)
		if (existing && protectedChild) {
			const state = nextState(mutation, null, null)
			if (!state) return false
			if (existing.type !== FileType.Directory || mutation.meta.type !== FileType.Directory) {
				await nodes.save({ ...state, materialization: 'blocked' })
				return true
			}
			const { meta, xattrs } = inodeMetaFromSync(mutation.meta)
			await port.upsertInode(existing.ino, { ...meta, ctimeNs: 0n }, undefined, xattrs)
			await nodes.save({ ...state, localIno: existing.ino, materialization: 'attached' })
			port.emit({ ino: existing.ino, kind: 'meta', source: opts?.source })
			return true
		}
		const ino = port.mintIno()
		const state = nextState(mutation, null, ino)
		if (!state) return false
		const { meta, xattrs } = inodeMetaFromSync(mutation.meta)
		await port.upsertInode(
			ino,
			{ ...meta, ctimeNs: 0n },
			mutation.contentHash,
			xattrs,
			mutation.contentHash === undefined ? undefined : opts?.content?.get(mutation.contentHash)
		)
		await port.setDirent(parent.localIno, mutation.name, ino, mutation.meta.type)
		await nodes.save(state)
		port.emit({ ino, kind: 'meta', source: opts?.source })
		await emitDirent(port, ino, parent.localIno, mutation.name, opts?.source)
		if (mutation.meta.type === FileType.Regular)
			port.emit({ ino, kind: 'content', source: opts?.source })
		return true
	}

	if (!previous) return false
	if (previous.localIno === null) {
		const state = nextState(mutation, previous, null)
		if (!state) return false
		await nodes.save(state)
		return true
	}
	if (mutation.kind === 'move') {
		const from = previous.parentId === null ? null : await nodes.get(previous.parentId)
		const to = await nodes.get(mutation.parentId)
		if (from?.localIno == null || to?.localIno == null) return false
		const logicalFromPath = await storedPath(nodes, previous)
		const canProtect =
			logicalFromPath !== null &&
			(opts?.ignore ?? []).some((root) => root.startsWith(`${logicalFromPath}/`))
		const fromPath = canProtect ? await port.pathOf(previous.localIno) : null
		const toParentPath = canProtect ? await port.pathOf(to.localIno) : null
		const toPath = toParentPath === null ? null : joinPath(toParentPath, mutation.name)
		const subtree = canProtect ? await port.enumerateSubtree(previous.localIno) : []
		const protectedChild =
			fromPath !== null &&
			subtree.some(
				(entry) => entry.rel !== '' && ignoredPath(opts?.ignore ?? [], fromPath + entry.rel)
			)
		if (protectedChild && fromPath !== null && toPath !== null) {
			// Keep ignored bytes at their old absolute path. Clone only the directory
			// spine that holds them, and move the visible branches to the new path.
			const root = await port.readMetaXattrs(previous.localIno)
			if (!root || root.meta.type !== FileType.Directory) return false
			const rootIno = port.mintIno()
			await port.upsertInode(rootIno, root.meta, root.meta.contentHash, root.xattrs)
			await port.setDirent(to.localIno, mutation.name, rootIno, FileType.Directory)
			const state = nextState(mutation, previous, rootIno)
			if (!state) return false
			await nodes.save(state)

			const newDirs = new Map<string, Ino>([['', rootIno]])
			const movedDirs: string[] = []
			for (const entry of subtree
				.filter(({ rel }) => rel !== '')
				.sort((a, b) => a.rel.length - b.rel.length)) {
				if (ignoredPath(opts?.ignore ?? [], fromPath + entry.rel)) continue
				if (movedDirs.some((rel) => entry.rel === rel || entry.rel.startsWith(`${rel}/`))) continue
				const slash = entry.rel.lastIndexOf('/')
				const parentRel = slash === 0 ? '' : entry.rel.slice(0, slash)
				const name = entry.rel.slice(slash + 1)
				const newParentIno = newDirs.get(parentRel)
				if (newParentIno === undefined) continue
				const current = await port.readMetaXattrs(entry.ino)
				if (!current) continue
				const hasProtectedChild =
					current.meta.type === FileType.Directory &&
					subtree.some(
						(child) =>
							child.rel.startsWith(`${entry.rel}/`) &&
							ignoredPath(opts?.ignore ?? [], fromPath + child.rel)
					)
				if (hasProtectedChild) {
					const ino = port.mintIno()
					await port.upsertInode(ino, current.meta, current.meta.contentHash, current.xattrs)
					await port.setDirent(newParentIno, name, ino, current.meta.type)
					const id = await nodes.idFor(entry.ino)
					const childState = id === null ? null : await nodes.get(id)
					if (childState)
						await nodes.save({ ...childState, localIno: ino, materialization: 'attached' })
					newDirs.set(entry.rel, ino)
					continue
				}
				const oldParentPath = fromPath + parentRel
				const oldParentIno = await port.resolveIno(oldParentPath)
				if (oldParentIno === null) continue
				await port.deleteDirent(oldParentIno, name)
				await port.setDirent(newParentIno, name, entry.ino, current.meta.type)
				if (current.meta.type === FileType.Directory) movedDirs.push(entry.rel)
			}
			port.emit({
				ino: rootIno,
				kind: 'dirent',
				dirIno: to.localIno,
				name: mutation.name,
				source: opts?.source
			})
			return true
		}
		await port.deleteDirent(from.localIno, previous.name)
		await port.setDirent(to.localIno, mutation.name, previous.localIno, previous.type)
		const state = nextState(mutation, previous, previous.localIno)
		if (!state) return false
		await nodes.save(state)
		// The inode and parent/name pair are enough to invalidate caches. Do not resolve
		// either path here: a database backend would need a recursive ancestor query.
		port.emit({
			ino: previous.localIno,
			kind: 'dirent',
			dirIno: from.localIno,
			name: previous.name,
			source: opts?.source
		})
		port.emit({
			ino: previous.localIno,
			kind: 'dirent',
			dirIno: to.localIno,
			name: mutation.name,
			source: opts?.source
		})
		return true
	}
	if (mutation.kind === 'delete') {
		const logicalPath = await storedPath(nodes, previous)
		const canProtect =
			logicalPath !== null &&
			(opts?.ignore ?? []).some((root) => root.startsWith(`${logicalPath}/`))
		const path = canProtect ? await port.pathOf(previous.localIno) : null
		const protectedChild =
			path !== null &&
			(await port.enumerateSubtree(previous.localIno)).some(
				(entry) => entry.rel !== '' && ignoredPath(opts?.ignore ?? [], path + entry.rel)
			)
		if (protectedChild) {
			const state = nextState(mutation, previous, null)
			if (!state) return false
			await nodes.save({ ...state, materialization: 'blocked' })
			return true
		}
		const parent = previous.parentId === null ? null : await nodes.get(previous.parentId)
		if (parent?.localIno != null) {
			await port.deleteDirent(parent.localIno, previous.name)
			await emitDirent(port, previous.localIno, parent.localIno, previous.name, opts?.source)
		}
		await port.deleteInodeIfUnreferenced(previous.localIno)
		const state = nextState(mutation, previous, null)
		if (!state) return false
		await nodes.save(state)
		port.emit({ ino: previous.localIno, kind: 'meta', source: opts?.source })
		return true
	}

	const state = nextState(mutation, previous, previous.localIno)
	if (!state) return false
	const { meta, xattrs } = inodeMetaFromSync(mutation.meta)
	await port.upsertInode(
		previous.localIno,
		{ ...meta, ctimeNs: 0n },
		mutation.contentHash,
		xattrs,
		mutation.contentHash === undefined ? undefined : opts?.content?.get(mutation.contentHash)
	)
	await nodes.save(state)
	port.emit({ ino: previous.localIno, kind: 'meta', source: opts?.source })
	if (mutation.meta.type === FileType.Regular)
		port.emit({ ino: previous.localIno, kind: 'content', source: opts?.source })
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
	opts?: {
		source?: string
		content?: ReadonlyMap<string, Uint8Array>
		ignore?: readonly string[]
	}
): Promise<void> {
	await bindRoot(port, nodes)
	for (const operation of operations) {
		const accepted: NodeMutation[] = []
		for (const mutation of operation.mutations)
			if (await applyMutation(port, nodes, mutation, opts)) accepted.push(mutation)
		if (accepted.length > 0)
			await nodes.append({ operationId: operation.operationId, mutations: accepted }, opts?.source)
	}
}

/** Apply authored operations under the adapter's transaction. */
export async function acceptNodeOperationsOver(
	port: TreePort,
	nodes: NodeStore,
	operations: readonly NodeOperation[],
	opts?: {
		source?: string
		origin?: string
		content?: ReadonlyMap<string, Uint8Array>
		ignore?: readonly string[]
	}
): Promise<NodeOperationResult[]> {
	await bindRoot(port, nodes)
	return acceptNodeOperations(
		port,
		nodes,
		operations,
		ROOT_NODE_ID,
		(mutation) => applyMutation(port, nodes, mutation, opts),
		opts
	)
}
// ── Replica ──────────────────────────────────────────────────────────────────

export interface NodeReplica {
	subscription(): Promise<IgnoreSubscriptionPolicy>
	nodeDeltas(
		cursor: SyncCursor,
		opts?: { excludeLocalSource?: string; limit?: number }
	): Promise<{ operations: NodeOperation[]; to: SyncCursor; done: boolean }>
	applyNodeOperations(
		operations: readonly NodeOperation[],
		getBlobByHash: (hash: string) => Promise<Uint8Array>,
		opts?: { source?: string; origin?: string }
	): Promise<NodeOperationResult[]>
	reconcileNodeSnapshot?(
		operations: readonly NodeOperation[],
		getBlobByHash: (hash: string) => Promise<Uint8Array>,
		opts?: {
			source?: string
			reconcileId?: string
			preserveIds?: ReadonlySet<string>
			pendingIds?: ReadonlySet<string>
			preserveAttached?: boolean
			removeStale?: boolean
		}
	): Promise<void>
	getBlobByHash(hash: string): Promise<Uint8Array>
	hasBlobByHash(hash: string): Promise<boolean>
	putBlobByHash(hash: string, data: Uint8Array): Promise<void>
	nodeSnapshot: SyncCapability['nodeSnapshot']
	getSnapshotBlob: SyncCapability['getSnapshotBlob']
	closeSnapshot: SyncCapability['closeSnapshot']
}

function createNodeReplica(
	sync: SyncCapability,
	addressed?: ContentStore,
	authoritative = false
): NodeReplica {
	const staged = new Map<string, Uint8Array>()
	const outgoing = new Map<string, Uint8Array>()
	const content = addressed
		? {
				async prepare(hashes: readonly string[], getBlob: (hash: string) => Promise<Uint8Array>) {
					for (const hash of hashes) {
						if (await addressed.hasByHash(hash)) continue
						await addressed.putByHash(hash, await verifyBytes(hash, await getBlob(hash)))
					}
					return undefined
				},
				async get(hash: string) {
					const blob = await addressed.getByHash(hash)
					if (!blob) throw new Error(`ENOENT: blob ${hash}`)
					return blob
				},
				has: (hash: string) => addressed.hasByHash(hash),
				async put(hash: string, data: Uint8Array) {
					await addressed.putByHash(hash, await verifyBytes(hash, data))
				},
				release(_hashes: readonly string[]) {}
			}
		: {
				async prepare(hashes: readonly string[], getBlob: (hash: string) => Promise<Uint8Array>) {
					const blobs = new Map<string, Uint8Array>()
					for (const hash of hashes) {
						const blob = staged.get(hash) ?? (await getBlob(hash))
						blobs.set(hash, await verifyBytes(hash, blob))
					}
					return blobs
				},
				async get(hash: string) {
					const pending = staged.get(hash) ?? outgoing.get(hash)
					if (pending) return pending.slice()
					return sync.getBlobByHash(hash)
				},
				async has(hash: string) {
					try {
						await this.get(hash)
						return true
					} catch {
						return false
					}
				},
				async put(hash: string, data: Uint8Array) {
					staged.set(hash, (await verifyBytes(hash, data)).slice())
				},
				release(hashes: readonly string[]) {
					for (const hash of hashes) staged.delete(hash)
				}
			}

	return {
		async subscription() {
			const effectiveIgnore: readonly string[] = []
			return {
				effectiveIgnore,
				effectiveHash: await hashIgnore(effectiveIgnore),
				identityEpoch: ROOT_NODE_ID
			}
		},
		nodeSnapshot: sync.nodeSnapshot,
		getSnapshotBlob: sync.getSnapshotBlob,
		closeSnapshot: sync.closeSnapshot,
		async nodeDeltas(cursor, opts) {
			const { retainedContent, ...result } = await sync.nodeDeltas(cursor, {
				...opts,
				retainContent: !addressed
			})
			if (!addressed) {
				outgoing.clear()
				for (const [hash, blob] of retainedContent ?? []) outgoing.set(hash, blob)
			}
			return result
		},
		async applyNodeOperations(operations, getBlobByHash, opts) {
			let ready = operations
			const missingByOperation = new Map<NodeOperation, string>()
			const wantedByOperation = new Map<NodeOperation, string[]>()
			if (authoritative) {
				for (const operation of operations)
					wantedByOperation.set(
						operation,
						await sync.wantedContent([operation], { authoritative: true })
					)
				const wanted = new Set([...wantedByOperation.values()].flat())
				const missing = new Set<string>()
				for (const hash of wanted) if (!(await content.has(hash))) missing.add(hash)
				if (missing.size > 0) {
					for (const [operation, hashes] of wantedByOperation) {
						const hash = hashes.find((candidate) => missing.has(candidate))
						if (hash) missingByOperation.set(operation, hash)
					}
					ready = operations.filter((operation) => !missingByOperation.has(operation))
				}
			}
			const wanted = authoritative
				? [...new Set(ready.flatMap((operation) => wantedByOperation.get(operation) ?? []))]
				: await sync.wantedContent(ready)
			const blobs = await content.prepare(wanted, getBlobByHash)
			try {
				if (authoritative) {
					const accepted = await sync.acceptNodeOperations(ready, { ...opts, content: blobs })
					let index = 0
					return operations.map((operation): NodeOperationResult => {
						const hash = missingByOperation.get(operation)
						if (hash)
							return {
								status: 'rejected',
								reason: 'missing_content',
								operationId: operation.operationId,
								hash
							}
						const result = accepted[index++]
						if (!result) throw new Error('authority result is missing')
						return result
					})
				}
				await sync.applyNodeOperations(ready, { ...opts, content: blobs })
				return ready.map((operation) => ({ status: 'accepted' as const, operation }))
			} finally {
				content.release(wanted)
			}
		},
		async reconcileNodeSnapshot(operations, getBlobByHash, opts) {
			const wanted = [
				...new Set(
					mutationsOf(operations).flatMap((mutation) =>
						mutation.kind === 'create' && mutation.contentHash ? [mutation.contentHash] : []
					)
				)
			]
			const blobs = await content.prepare(wanted, getBlobByHash)
			try {
				await sync.reconcileNodeSnapshot(operations, { ...opts, content: blobs })
			} finally {
				content.release(wanted)
			}
		},
		getBlobByHash: (hash) => (addressed ? sync.getBlobByHash(hash) : content.get(hash)),
		async hasBlobByHash(hash) {
			if (!addressed) return content.has(hash)
			try {
				await sync.getBlobByHash(hash)
				return true
			} catch {
				return false
			}
		},
		putBlobByHash: (hash, data) => content.put(hash, data)
	}
}

/** A local follower over one filesystem and its discovered sync capability. */
export function nodeSyncReplica(sync: SyncCapability, addressed?: ContentStore): NodeReplica {
	return createNodeReplica(sync, addressed)
}

/** A server authority that validates authored operations before it applies them. */
export function nodeAuthorityReplica(sync: SyncCapability, addressed?: ContentStore): NodeReplica {
	return createNodeReplica(sync, addressed, true)
}
