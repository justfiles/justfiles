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
import {
	type NodeSnapshotBlob,
	type NodeSnapshotBusy,
	type NodeSnapshotClose,
	type NodeSnapshotPage,
	type NodeSnapshotRestart,
	nodeSnapshotSessions,
	type SnapshotView
} from './node-snapshot'
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
		return [{ ...row, operation: { mutations } }]
	})
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
	/** Every current live node; snapshot atomicity belongs to the owning adapter. */
	live(): Promise<NodeState[]>
	save(state: NodeState): Promise<void>
	/** Append accepted mutations while removing rows they supersede. */
	append(operation: NodeOperation, localSource?: string): Promise<void>
	read(after: number, limit: number): Promise<NodeJournalRow[]>
	head(): Promise<number>
}

/** Sync-owned seams attached to one node-addressed filesystem backend. */
export interface NodeSyncModule {
	readonly nodes: NodeStore
	/** Atomically capture selected journal content when the adapter requires it. */
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
		opts?: { source?: string; content?: ReadonlyMap<string, Uint8Array> }
	): Promise<void>
	openSnapshotView(): Promise<SnapshotView>
}

/** Optimized sync behavior attached without extending the filesystem package. */
export interface SyncCapability {
	nodeDeltas(
		cursor: SyncCursor,
		opts?: { excludeLocalSource?: string; limit?: number; retainContent?: boolean }
	): Promise<{
		operations: NodeOperation[]
		to: SyncCursor
		done: boolean
		retainedContent?: ReadonlyMap<string, Uint8Array>
	}>
	wantedContent(operations: readonly NodeOperation[]): Promise<string[]>
	applyNodeOperations(
		operations: readonly NodeOperation[],
		opts?: { source?: string; content?: ReadonlyMap<string, Uint8Array> }
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
	exclusive: <T>(task: () => Promise<T>) => Promise<T> = (task) => task()
): SyncCapability {
	const snapshots = nodeSnapshotSessions(() => module.openSnapshotView())
	const content = storage.caps?.content

	async function readLiveBlob(hash: string): Promise<Uint8Array> {
		for (const node of await module.nodes.live()) {
			if (node.contentHash !== hash || node.localIno === null) continue
			const blob = content ? await content.getByHash(hash) : await storage.getBlob(node.localIno)
			if (!blob) throw new Error(`ENOENT: blob ${hash}`)
			return verifyBytes(hash, blob)
		}
		throw new Error(`ENOENT: blob ${hash}`)
	}

	return {
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
				const operations = rows.filter(include).map((row) => row.operation)
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
		async wantedContent(operations) {
			const wanted = new Set<string>()
			for (const mutation of mutationsOf(operations)) {
				if (mutation.kind !== 'create' && mutation.kind !== 'update') continue
				const previous = await module.nodes.get(mutation.nodeId)
				if (previous && (mutation.kind === 'create' || previous.revision >= mutation.revision))
					continue
				if (mutation.contentHash) wanted.add(mutation.contentHash)
			}
			return [...wanted]
		},
		applyNodeOperations: (operations, opts) => module.apply(operations, opts),
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
		(expected && (previous.parentId !== expected.parentId || previous.name !== expected.name))
	)
		return null
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
				// A bare putDirent can add another name for an existing inode. Node v2
				// does not model hard links, so it must not mint a second node identity.
				if ((await nodes.idFor(effect.ino)) !== null) return
				const parentId = await nodes.idFor(effect.dirIno)
				if (parentId === null) return
				const mutation = await createMutation(port, parentId, effect.name, effect.ino)
				if (mutation) await commit([{ mutation, ino: effect.ino }])
				return
			}
			if (effect.kind === 'unlink') {
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
				const parentId = await nodes.idFor(effect.toDirIno)
				if (parentId === null) return
				const entries: { mutation: NodeMutation; ino: Ino | null }[] = []
				if (effect.displaced !== null) {
					const displaced = await deleteMutation(nodes, effect.displaced, {
						parentId,
						name: effect.toName
					})
					if (displaced) entries.push({ mutation: displaced, ino: null })
				}
				const id = await nodes.idFor(effect.ino)
				const sourceParentId = await nodes.idFor(effect.fromDirIno)
				const previous = id === null ? null : await nodes.get(id)
				if (
					id === null ||
					sourceParentId === null ||
					!previous ||
					previous.parentId !== sourceParentId ||
					previous.name !== effect.fromName
				) {
					await commit(entries)
					return
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
	opts?: { source?: string; content?: ReadonlyMap<string, Uint8Array> }
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
	opts?: { source?: string; content?: ReadonlyMap<string, Uint8Array> }
): Promise<void> {
	await bindRoot(port, nodes)
	for (const operation of operations) {
		const accepted: NodeMutation[] = []
		for (const mutation of operation.mutations)
			if (await applyMutation(port, nodes, mutation, opts)) accepted.push(mutation)
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
	nodeSnapshot: SyncCapability['nodeSnapshot']
	getSnapshotBlob: SyncCapability['getSnapshotBlob']
	closeSnapshot: SyncCapability['closeSnapshot']
}

/** A local node replica over one filesystem and its discovered sync capability. */
export function nodeSyncReplica(sync: SyncCapability, addressed?: ContentStore): NodeReplica {
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
			const wanted = await sync.wantedContent(operations)
			const blobs = await content.prepare(wanted, getBlobByHash)
			try {
				await sync.applyNodeOperations(operations, { ...opts, content: blobs })
			} finally {
				content.release(wanted)
			}
		},
		getBlobByHash: (hash) => content.get(hash),
		hasBlobByHash: (hash) => content.has(hash),
		putBlobByHash: (hash, data) => content.put(hash, data)
	}
}
