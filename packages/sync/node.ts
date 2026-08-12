/**
 * Node-addressed sync (protocol v2) — EXPERIMENTAL, beside path v1.
 *
 * v1 addresses the wire by PATH, so `atomicMove` of a directory becomes 2N
 * journal rows (see `pathSyncObserver`). Here identity is a `SyncNodeId` shared by
 * every replica, location is `parentId + name`, and a move is ONE mutation
 * whatever the subtree size — the receiving replica rebinds one dirent.
 *
 * A replica stores its own `SyncNodeId <-> local Ino` mapping and NOTHING about
 * anyone else's inodes. `packages/fs` stays sync-free: this module is a second
 * `MutationObserver` over the SAME filesystem, choosing a different recording of
 * the same `TreeEffect`s.
 */

import type { Storage } from '@justfiles/fs/storage'
import type { MutationObserver, TreePort } from '@justfiles/fs/storage.shared'
import { joinPath } from '@justfiles/fs/storage.shared'
import type { Ino } from '@justfiles/fs/types'
import { FileType } from '@justfiles/fs/types'
import { z } from 'zod'
import { splitPath } from './path'
import type { SyncCursor } from './replica'
import { ignorePrefixes, PAGE } from './replica'
import { ContentHash, inodeMetaFromSync, SyncMeta, syncMetaFromInode } from './wire'

// ── Identity ──────────────────────────────────────────────────────────────────

/** One logical file or directory, shared by every replica that can see it. */
export type SyncNodeId = string

/**
 * The one identity every replica already agrees on, bound locally to its own
 * `rootIno`. A well-known constant rather than a negotiated ID: two replicas that
 * have never met still start from the same node.
 */
export const ROOT_NODE_ID: SyncNodeId = '00000000-0000-0000-0000-000000000000'

/**
 * Minted by the CREATING replica, before publication — a create must work
 * offline, so identity cannot come from a server round trip.
 */
export function newNodeId(): SyncNodeId {
	return crypto.randomUUID()
}

// ── Wire ──────────────────────────────────────────────────────────────────────

const nodeId = z.string().min(1)
/**
 * Per-node revision. Numeric (not v1's decimal string): a revision is server-
 * assigned in later phases and never approaches 2^53. Phase 1 is single-writer —
 * the author takes `previous + 1`.
 */
const revision = z.number().int().nonnegative()

/**
 * A mutation of ONE node. Identity is `nodeId`; location is `parentId + name`;
 * content stays hash-addressed, so a move carries no content and re-uploads
 * nothing. No local inode ever appears here.
 */
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
 * The atomic unit of both the journal and the wire: an ORDERED group of mutations
 * that must be applied together or not at all.
 *
 * Ordinary work is one mutation per operation. The group exists for the
 * visibility boundary — a subtree publication is its creates parent-first, an
 * unpublication is its deletes child-first (each delete naming the revision it
 * expects, which IS the manifest), and a move that crosses a nested ignore root is
 * the move plus exactly those two. No extra wire verbs, and no intermediate state
 * in which half a subtree is visible.
 */
export const NodeOperation = z.object({ mutations: z.array(NodeMutation).min(1) })
export type NodeOperation = z.infer<typeof NodeOperation>

/** Flatten operations to the mutations they carry, in order. */
export function mutationsOf(operations: readonly NodeOperation[]): NodeMutation[] {
	return operations.flatMap((o) => o.mutations)
}

// ── Visibility (the synchronised projection of a local tree) ──────────────────

/**
 * What this replica synchronises. Protocol v2 represents the projection of a
 * local tree, not the whole tree: an ignored root is outside it in BOTH
 * directions, so its nodes acquire no identity, and each replica keeps its own
 * bytes at the same ignored path.
 *
 * ONE generic list, supplied by the caller. `packages/sync` contains no product
 * path of its own — the engine's own state simply is not kept in the volume, so
 * excluding it needs no rule.
 */
export interface Projection {
	/** Normalised ignore roots: canonical, deduplicated, no root under another. */
	readonly roots: readonly string[]
	ignored(path: string): boolean
}

/**
 * The canonical form of one ignore root, or null when it names nothing this can
 * hide. A root is matched against paths the VOLUME resolved, so it has to be
 * reduced the same way first: `/x/../private`, `//private/` and `/./private` all
 * name `/private`, and a matcher that took them literally would leave `/private`
 * visible — an ignore list failing OPEN, which is the dangerous direction.
 */
function canonicalRoot(raw: string): string | null {
	if (!raw.startsWith('/')) return null
	const segments: string[] = []
	for (const segment of raw.split('/')) {
		if (segment === '' || segment === '.') continue
		if (segment === '..') {
			segments.pop()
			continue
		}
		segments.push(segment.normalize('NFC'))
	}
	// Everything reduced away: that is the root itself, which would ignore the whole
	// volume. A caller that wants to sync nothing does not connect a replica.
	return segments.length === 0 ? null : `/${segments.join('/')}`
}

/** Normalise a caller's ignore list and give it segment-aware matching. */
export function projection(ignore?: readonly string[]): Projection {
	const seen = new Set<string>()
	for (const raw of ignore ?? []) {
		const root = canonicalRoot(raw)
		if (root !== null) seen.add(root)
	}
	const roots: string[] = []
	// Shortest first, so a root already covered by an ancestor root is dropped.
	for (const p of [...seen].sort()) if (!roots.some((r) => p.startsWith(`${r}/`))) roots.push(p)
	const matches = ignorePrefixes(roots)
	return { roots, ignored: (path) => roots.length > 0 && matches(path) }
}

// ── Node state + the adapter seam ─────────────────────────────────────────────

/**
 * The last accepted state of one node ON THIS REPLICA. `localIno` is the local
 * binding — `null` for a node this replica knows but does not materialise (a
 * tombstone, or state outside its projection).
 */
export type NodeState = {
	id: SyncNodeId
	localIno: Ino | null
	parentId: SyncNodeId | null
	name: string
	type: FileType
	revision: number
	deleted: boolean
	/**
	 * The metadata this replica last accepted for the node. Held HERE rather than
	 * read back from the inode so that a node with no local inode is still complete
	 * — which is what lets a subtree that moves back into view be rebuilt locally
	 * instead of re-fetched mid-transaction.
	 */
	meta: SyncMeta
	contentHash?: string
}

/** A journal row: one operation at its position, plus who applied it locally. */
export type NodeJournalRow = {
	seq: number
	operation: NodeOperation
	/** Set when the SYNC layer applied it (never for a user's own write). */
	localSource?: string
}

/**
 * The node-sync persistence seam every adapter implements (memory here; SQLite
 * and IndexedDB later). Deliberately small: bidirectional identity lookup, live
 * state plus tombstones, and an ordered journal.
 *
 * An adapter must commit a tree mutation, its identity mapping, its node state
 * and its journal row TOGETHER. In memory that is free; elsewhere it is one
 * transaction.
 */
export interface NodeStore {
	get(id: SyncNodeId): Promise<NodeState | null>
	/** The sync ID bound to a LOCAL inode, or null when outside the projection. */
	idFor(ino: Ino): Promise<SyncNodeId | null>
	/** Live (non-tombstoned) children of a node. */
	children(parentId: SyncNodeId): Promise<NodeState[]>
	save(state: NodeState): Promise<void>
	append(operation: NodeOperation, localSource?: string): Promise<void>
	read(after: number, limit: number): Promise<NodeJournalRow[]>
	head(): Promise<number>
}

/** Sync-owned seams for one node-addressed filesystem backend. */
export interface NodeSyncModule {
	readonly nodes: NodeStore
	/** This replica's visibility boundary, applied in both directions. */
	readonly view: Projection
	/**
	 * Live projection nodes as `create` mutations, ordered by effective path
	 * (which is parent-before-child, since a parent path is a strict prefix), keyset
	 * paged after `afterPath`. The path is paging bookkeeping and never wire.
	 */
	snapshot(afterPath: string, limit: number): Promise<{ path: string; mutation: NodeMutation }[]>
	/** Apply remote operations to the tree, the identity mapping and the journal. */
	apply(operations: readonly NodeOperation[], opts?: { source?: string }): Promise<void>
}

/** A filesystem paired with its node-sync module. */
export interface NodeStorage extends Storage {
	readonly nodeSync: NodeSyncModule
}

// ── State folding (pure — the same rule on the author and the receiver) ───────

/**
 * The node state one accepted mutation produces. `prev` is the current state
 * (null for a create); `localIno` is this replica's own binding. Returns null when
 * the mutation names a node this replica does not know — there is nothing to fold.
 */
export function nextState(
	m: NodeMutation,
	prev: NodeState | null,
	localIno: Ino | null
): NodeState | null {
	if (m.kind === 'create')
		return {
			id: m.nodeId,
			localIno,
			parentId: m.parentId,
			name: m.name,
			type: m.meta.type,
			revision: m.revision,
			deleted: false,
			meta: m.meta,
			contentHash: m.contentHash
		}
	if (!prev) return null
	if (m.kind === 'update')
		return {
			...prev,
			localIno,
			type: m.meta.type,
			revision: m.revision,
			meta: m.meta,
			contentHash: m.contentHash
		}
	if (m.kind === 'move')
		return { ...prev, localIno, parentId: m.parentId, name: m.name, revision: m.revision }
	// A delete drops the local binding and KEEPS the identity: the tombstone is what
	// stops a recreated path from re-using the ID.
	return { ...prev, localIno: null, deleted: true, revision: m.revision }
}

/**
 * Bind the well-known root to this replica's own root inode, once. Every entry
 * point calls it, so no adapter has to know its backend's root inode.
 */
async function bindRoot(port: TreePort, nodes: NodeStore): Promise<void> {
	if (await nodes.get(ROOT_NODE_ID)) return
	const ino = await port.resolveIno('/')
	if (ino === null) return
	const mx = await port.readMetaXattrs(ino)
	await nodes.save({
		id: ROOT_NODE_ID,
		localIno: ino,
		parentId: null,
		name: '',
		type: FileType.Directory,
		revision: 0,
		deleted: false,
		meta: mx
			? syncMetaFromInode(mx.meta, mx.xattrs)
			: { type: FileType.Directory, mode: 0o755, mtimeNs: '0', size: '0' }
	})
}

/** The mutation's own `meta` + `contentHash`, read from the local inode. */
async function metaOf(
	port: TreePort,
	ino: Ino
): Promise<{ meta: SyncMeta; contentHash?: string } | null> {
	const mx = await port.readMetaXattrs(ino)
	if (!mx) return null
	const meta = syncMetaFromInode(mx.meta, mx.xattrs)
	return mx.meta.contentHash === undefined ? { meta } : { meta, contentHash: mx.meta.contentHash }
}

/** The `create` for a local inode taking its FIRST identity, read from the tree. */
async function created(
	port: TreePort,
	parentId: SyncNodeId,
	name: string,
	ino: Ino
): Promise<NodeMutation | null> {
	const state = await metaOf(port, ino)
	if (!state) return null
	return {
		kind: 'create',
		nodeId: newNodeId(),
		parentId,
		name,
		revision: 1,
		meta: state.meta,
		...(state.contentHash === undefined ? {} : { contentHash: state.contentHash })
	}
}

/** The `delete` for whatever node is bound to `ino`, or null if it holds none. */
async function tombstone(nodes: NodeStore, ino: Ino): Promise<NodeMutation | null> {
	const id = await nodes.idFor(ino)
	if (id === null) return null
	const prev = await nodes.get(id)
	if (!prev || prev.deleted) return null
	return { kind: 'delete', nodeId: id, revision: prev.revision + 1 }
}

// ── The observer: one TreeEffect in, one node operation out ───────────────────

/**
 * Record filesystem effects as node mutations. The counterpart of
 * `pathSyncObserver`, over the same effects and the same backends — a `move` is
 * recorded as ONE mutation instead of 2N path rows.
 */
export function nodeSyncObserver(nodes: NodeStore, view: Projection): MutationObserver {
	/**
	 * One operation under construction. Each mutation folds into node state AS IT IS
	 * ADDED, so a later mutation in the same operation can resolve identity the
	 * earlier ones established — which is what lets a projection move publish a
	 * subtree under a parent it created two mutations ago.
	 */
	function open(): {
		add(mutation: NodeMutation, ino: Ino | null): Promise<void>
		commit(): Promise<void>
	} {
		const mutations: NodeMutation[] = []
		return {
			async add(mutation, ino) {
				const prev = mutation.kind === 'create' ? null : await nodes.get(mutation.nodeId)
				const state = nextState(mutation, prev, ino)
				if (state) await nodes.save(state)
				mutations.push(mutation)
			},
			async commit() {
				if (mutations.length > 0) await nodes.append({ mutations })
			}
		}
	}

	type Operation = ReturnType<typeof open>

	/**
	 * Publish the local subtree at `path` — every node in it gets a FRESH identity,
	 * parent before child, and a nested ignore root inside it stays out. O(N) by
	 * design: this is the boundary crossing, not the ordinary move.
	 */
	async function publish(port: TreePort, op: Operation, path: string, ino: Ino): Promise<void> {
		const subtree = await port.enumerateSubtree(ino)
		// `rel` order is parent-before-child: a parent's rel is a prefix of its child's.
		for (const entry of [...subtree].sort((x, y) => (x.rel < y.rel ? -1 : 1))) {
			const full = path + entry.rel
			if (view.ignored(full)) continue
			if ((await nodes.idFor(entry.ino)) !== null) continue
			const { parentPath, name } = splitPath(full)
			const parentIno = await port.resolveIno(parentPath)
			const parentId = parentIno === null ? null : await nodes.idFor(parentIno)
			if (parentId === null) continue
			const mutation = await created(port, parentId, name, entry.ino)
			if (mutation) await op.add(mutation, entry.ino)
		}
	}

	/**
	 * Withdraw the shared subtree rooted at `id`: a delete per live node, child
	 * before parent, each naming the revision it expects. The LOCAL bytes are not
	 * touched — leaving the projection is not a deletion.
	 */
	async function unpublish(op: Operation, id: SyncNodeId): Promise<void> {
		const ordered: NodeState[] = []
		async function walk(parent: SyncNodeId): Promise<void> {
			for (const child of await nodes.children(parent)) {
				await walk(child.id)
				ordered.push(child)
			}
		}
		await walk(id)
		const root = await nodes.get(id)
		if (root && !root.deleted) ordered.push(root)
		for (const node of ordered)
			await op.add({ kind: 'delete', nodeId: node.id, revision: node.revision + 1 }, null)
	}

	/**
	 * The ignore roots that sit strictly BELOW either end of a move, as suffixes
	 * relative to the moved node. Scanning the ignore LIST (never the moved subtree)
	 * is what keeps an ordinary move independent of subtree size.
	 */
	function crossings(oldPath: string, newPath: string): string[] {
		const suffixes = new Set<string>()
		for (const root of view.roots) {
			if (root.startsWith(`${oldPath}/`)) suffixes.add(root.slice(oldPath.length))
			if (root.startsWith(`${newPath}/`)) suffixes.add(root.slice(newPath.length))
		}
		// Shortest first, so a published parent exists before a nested one is decided.
		return [...suffixes].sort()
	}

	return {
		async record(port, effect) {
			await bindRoot(port, nodes)
			switch (effect.kind) {
				case 'link': {
					const parentId = await nodes.idFor(effect.dirIno)
					// Nothing names this parent in the projection, so the child is not in it
					// either — no identity to mint. That covers everything DEEP inside an
					// ignored root; only a direct child of a visible parent needs the path.
					if (parentId === null) return
					if (view.roots.length > 0) {
						const dirPath = await port.pathOf(effect.dirIno)
						if (dirPath === null || view.ignored(joinPath(dirPath, effect.name))) return
					}
					const mutation = await created(port, parentId, effect.name, effect.ino)
					if (!mutation) return
					const op = open()
					await op.add(mutation, effect.ino)
					await op.commit()
					return
				}
				case 'unlink': {
					const mutation = await tombstone(nodes, effect.ino)
					if (!mutation) return
					const op = open()
					await op.add(mutation, null)
					await op.commit()
					return
				}
				case 'move': {
					const fromDir = await port.pathOf(effect.fromDirIno)
					const toDir = await port.pathOf(effect.toDirIno)
					if (fromDir === null || toDir === null) return
					// The from-directory itself did not move (a node cannot move below
					// itself), so its path still resolves after the rebind.
					const oldPath = joinPath(fromDir, effect.fromName)
					const newPath = joinPath(toDir, effect.toName)
					const id = await nodes.idFor(effect.ino)
					const destId = await nodes.idFor(effect.toDirIno)
					const wasShared = id !== null
					const isShared = destId !== null && !view.ignored(newPath)

					const op = open()
					// A move over a live name frees that node's inode, so its tombstone
					// belongs to the SAME operation — the destination name is never held by
					// two live nodes, not even between two applies.
					const displaced =
						effect.displaced === null ? null : await tombstone(nodes, effect.displaced)
					if (displaced) await op.add(displaced, null)

					if (wasShared && isShared) {
						const prev = await nodes.get(id)
						if (!prev) return
						// Withdraw what LEAVES, relocate, then publish what ENTERS — one
						// operation, so no intermediate state exposes an ignored path. When no
						// ignore root sits under either end (the ordinary case) this is exactly
						// one move, and nothing walks the subtree.
						const entering: string[] = []
						for (const suffix of crossings(oldPath, newPath)) {
							const before = view.ignored(oldPath + suffix)
							const after = view.ignored(newPath + suffix)
							if (before === after) continue
							if (after) {
								const ino = await port.resolveIno(newPath + suffix)
								const leavingId = ino === null ? null : await nodes.idFor(ino)
								if (leavingId !== null) await unpublish(op, leavingId)
							} else entering.push(suffix)
						}
						await op.add(
							{
								kind: 'move',
								nodeId: id,
								parentId: destId,
								name: effect.toName,
								revision: prev.revision + 1
							},
							effect.ino
						)
						for (const suffix of entering) {
							const path = newPath + suffix
							const ino = await port.resolveIno(path)
							if (ino !== null) await publish(port, op, path, ino)
						}
					} else if (isShared) {
						// It was outside the projection, so nothing about it was ever shared:
						// the whole subtree is published under new identities.
						await publish(port, op, newPath, effect.ino)
					} else if (wasShared) {
						await unpublish(op, id)
					}
					await op.commit()
					return
				}
				case 'meta':
				case 'content': {
					const id = await nodes.idFor(effect.ino)
					if (id === null) return
					const prev = await nodes.get(id)
					if (!prev || prev.deleted) return
					const state = await metaOf(port, effect.ino)
					if (!state) return
					const op = open()
					await op.add(
						{
							kind: 'update',
							nodeId: id,
							revision: prev.revision + 1,
							meta: state.meta,
							...(state.contentHash === undefined ? {} : { contentHash: state.contentHash })
						},
						effect.ino
					)
					await op.commit()
					return
				}
				default:
					return
			}
		}
	}
}

// ── Apply (the receiving side), over the same tx-scoped TreePort ──────────────

/**
 * Apply accepted operations to the tree, the identity mapping and the journal.
 * Writes through the `TreePort` (never the `Storage` surface), so the local
 * observer does not re-record what sync itself applied — the same arrangement
 * `applyJournaledOver` uses. Blob bytes are materialised out-of-band, before this
 * call.
 */
export async function applyNodeOperationsOver(
	port: TreePort,
	nodes: NodeStore,
	view: Projection,
	operations: readonly NodeOperation[],
	opts?: { source?: string }
): Promise<void> {
	await bindRoot(port, nodes)
	for (const operation of operations) {
		for (const m of operation.mutations) await applyMutation(port, nodes, view, m, opts?.source)
		await nodes.append(operation, opts?.source)
	}
}

/**
 * Where a node sits according to THIS replica's node state — reconstructed by
 * walking `parentId`, never read from the local tree, so it is right even for the
 * parts this replica does not materialise.
 */
export async function effectivePath(
	nodes: NodeStore,
	parentId: SyncNodeId | null,
	name: string,
	/**
	 * Ancestors that are not in the store yet because they arrived in the same
	 * batch. Needed only before an apply — a create's parent may be two mutations
	 * ahead of it.
	 */
	incoming?: ReadonlyMap<SyncNodeId, { parentId: SyncNodeId; name: string }>
): Promise<string | null> {
	const segments = [name]
	let cursor = parentId
	while (cursor !== null && cursor !== ROOT_NODE_ID) {
		const pending = incoming?.get(cursor)
		const parent = pending ?? (await nodes.get(cursor))
		if (!parent) return null
		segments.unshift(parent.name)
		cursor = parent.parentId
	}
	return cursor === null ? null : `/${segments.join('/')}`
}

/**
 * Would writing over `(parentIno, name)` destroy a directory that holds something
 * this replica ignores? An ignored path only survives while its ANCESTORS do, and
 * a regular-file inode cannot hold dirents, so a remote delete or replacement of
 * such a directory is SKIPPED: the local tree keeps it and diverges from the peer
 * there, which is what ignoring already means. Skipping mutates nothing, so there
 * is no new local change to push back and nothing flaps.
 */
async function shields(
	port: TreePort,
	view: Projection,
	parentIno: Ino,
	name: string,
	path: string
): Promise<boolean> {
	if (view.roots.length === 0) return false
	const existing = await port.getDirent(parentIno, name)
	if (!existing || existing.type !== FileType.Directory) return false
	const subtree = await port.enumerateSubtree(existing.ino)
	return subtree.some((n) => view.ignored(path + n.rel))
}

/**
 * Give a node — and everything under it that this replica knows — local inodes,
 * building them from the state alone. A node that this replica ignores keeps its
 * state and stays out of the tree, however it arrived.
 */
async function materialise(
	port: TreePort,
	nodes: NodeStore,
	view: Projection,
	node: NodeState,
	parentIno: Ino,
	parentPath: string | null,
	source?: string
): Promise<void> {
	const path = parentPath === null ? null : joinPath(parentPath, node.name)
	if (path !== null && view.ignored(path)) {
		await nodes.save({ ...node, localIno: null })
		return
	}
	const ino = node.localIno ?? port.mintIno()
	const { meta, xattrs } = inodeMetaFromSync(node.meta)
	await port.upsertInode(ino, { ...meta, ctimeNs: 0n }, node.contentHash, xattrs)
	await port.setDirent(parentIno, node.name, ino, node.type)
	await nodes.save({ ...node, localIno: ino })
	port.emit({ ino, kind: 'meta', source })
	port.emit({
		ino,
		kind: 'dirent',
		dirIno: parentIno,
		name: node.name,
		...(path === null ? {} : { path }),
		source
	})
	if (node.type === FileType.Regular) port.emit({ ino, kind: 'content', source })
	for (const child of await nodes.children(node.id))
		await materialise(port, nodes, view, child, ino, path, source)
}

/**
 * Take back the local materialisation of a node this replica may no longer show,
 * child first. The IDENTITY survives (`localIno: null`, not a tombstone) — the peer
 * still holds these nodes, so a later move back into view restores them.
 */
async function dematerialise(
	port: TreePort,
	nodes: NodeStore,
	node: NodeState,
	source?: string
): Promise<void> {
	for (const child of await nodes.children(node.id)) await dematerialise(port, nodes, child, source)
	if (node.localIno !== null) {
		const parent = node.parentId === null ? null : await nodes.get(node.parentId)
		if (parent?.localIno != null) {
			const dirPath = await port.pathOf(parent.localIno)
			await port.deleteDirent(parent.localIno, node.name)
			port.emit({
				ino: node.localIno,
				kind: 'dirent',
				dirIno: parent.localIno,
				name: node.name,
				...(dirPath === null ? {} : { path: joinPath(dirPath, node.name) }),
				source
			})
		}
		await port.deleteInodeIfUnreferenced(node.localIno)
		port.emit({ ino: node.localIno, kind: 'meta', source })
	}
	await nodes.save({ ...node, localIno: null })
}

async function applyMutation(
	port: TreePort,
	nodes: NodeStore,
	view: Projection,
	m: NodeMutation,
	source?: string
): Promise<void> {
	const prev = await nodes.get(m.nodeId)
	// Idempotent retry: this replica already accepted this revision (or a newer
	// one), so there is nothing left to do.
	if (prev && prev.revision >= m.revision) return

	if (m.kind === 'create') {
		const parent = await nodes.get(m.parentId)
		const parentIno = parent?.localIno ?? null
		if (!parent) return
		const path = await effectivePath(nodes, m.parentId, m.name)
		if (path === null) return
		const state = nextState(m, prev, prev?.localIno ?? null)
		if (!state) return
		// Outside this replica's projection: keep the identity and the state, put
		// nothing in the tree, and never bind it to whatever local bytes live there.
		// `materialise` re-checks the path itself, so this only decides whether there
		// is a parent inode to hang it from at all.
		if (parentIno === null) {
			await nodes.save({ ...state, localIno: null })
			return
		}
		if (await shields(port, view, parentIno, m.name, path)) return
		await materialise(port, nodes, view, state, parentIno, splitPath(path).parentPath, source)
		return
	}

	if (!prev) return
	if (m.kind === 'move') {
		const to = await nodes.get(m.parentId)
		const toIno = to?.localIno ?? null
		if (!to) return
		const state = nextState(m, prev, prev.localIno)
		if (!state) return
		const path = await effectivePath(nodes, m.parentId, m.name)
		const visible = toIno !== null && path !== null && !view.ignored(path)
		if (
			visible &&
			path !== null &&
			toIno !== null &&
			(await shields(port, view, toIno, m.name, path))
		)
			return
		if (visible && prev.localIno !== null && to.localIno !== null) {
			await nodes.save(state)
			// ONE dirent rebind, whatever the subtree holds — every descendant is keyed
			// by its own parent's inode, so none of them is touched or even read.
			const from = prev.parentId === null ? null : await nodes.get(prev.parentId)
			if (from?.localIno != null) await port.deleteDirent(from.localIno, prev.name)
			await port.setDirent(to.localIno, m.name, prev.localIno, prev.type)
			const toPath = await port.pathOf(to.localIno)
			port.emit({
				ino: prev.localIno,
				kind: 'dirent',
				dirIno: to.localIno,
				name: m.name,
				...(toPath === null ? {} : { path: joinPath(toPath, m.name) }),
				source
			})
			if (from?.localIno != null) {
				const fromPath = await port.pathOf(from.localIno)
				port.emit({
					ino: prev.localIno,
					kind: 'dirent',
					dirIno: from.localIno,
					name: prev.name,
					...(fromPath === null ? {} : { path: joinPath(fromPath, prev.name) }),
					source
				})
			}
			return
		}
		// The move crossed THIS replica's visibility boundary, in one direction or the
		// other. Neither direction echoes: the tree write happens through the port.
		if (visible && toIno !== null && path !== null) {
			await nodes.save(state)
			await materialise(
				port,
				nodes,
				view,
				{ ...state, localIno: null },
				toIno,
				splitPath(path).parentPath,
				source
			)
			return
		}
		// Withdraw from the OLD location — the dirent to remove is the one the node
		// still has — and only then record where it now belongs.
		if (prev.localIno !== null) await dematerialise(port, nodes, prev, source)
		await nodes.save({ ...state, localIno: null })
		return
	}
	if (m.kind === 'delete') {
		if (prev.localIno !== null) {
			const parent = prev.parentId === null ? null : await nodes.get(prev.parentId)
			const path = await effectivePath(nodes, prev.parentId, prev.name)
			if (
				parent?.localIno != null &&
				path !== null &&
				(await shields(port, view, parent.localIno, prev.name, path))
			)
				return
			if (parent?.localIno != null) {
				const dirPath = await port.pathOf(parent.localIno)
				await port.deleteDirent(parent.localIno, prev.name)
				port.emit({
					ino: prev.localIno,
					kind: 'dirent',
					dirIno: parent.localIno,
					name: prev.name,
					...(dirPath === null ? {} : { path: joinPath(dirPath, prev.name) }),
					source
				})
			}
			await port.deleteInodeIfUnreferenced(prev.localIno)
			port.emit({ ino: prev.localIno, kind: 'meta', source })
		}
		const state = nextState(m, prev, null)
		if (state) await nodes.save(state)
		return
	}
	if (m.kind === 'update') {
		const state = nextState(m, prev, prev.localIno)
		if (!state) return
		await nodes.save(state)
		// Nothing to write for a node this replica does not materialise; the state it
		// just recorded is what will rebuild it if it ever comes into view.
		if (prev.localIno === null) return
		const { meta, xattrs } = inodeMetaFromSync(m.meta)
		await port.upsertInode(prev.localIno, { ...meta, ctimeNs: 0n }, m.contentHash, xattrs)
		port.emit({ ino: prev.localIno, kind: 'meta', source })
		if (m.meta.type === FileType.Regular) port.emit({ ino: prev.localIno, kind: 'content', source })
	}
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

/**
 * Every live node of the projection as a `create`, ordered by effective path. Read
 * from the node store alone — the tree is not consulted, so a bootstrap needs no
 * journal history.
 *
 * Filtered by THIS replica's own view, which is not the same as "everything it
 * materialises": a peer with a narrower policy sends nodes this replica keeps as
 * state without materialising, and re-serving those to a third replica would
 * relay past a boundary this one was told to respect.
 */
export async function snapshotOf(
	nodes: NodeStore,
	view: Projection,
	afterPath: string,
	limit: number
): Promise<{ path: string; mutation: NodeMutation }[]> {
	const out: { path: string; mutation: NodeMutation }[] = []
	async function walk(parent: NodeState, parentPath: string): Promise<void> {
		for (const child of await nodes.children(parent.id)) {
			const path = joinPath(parentPath, child.name)
			if (view.ignored(path)) continue
			out.push({
				path,
				mutation: {
					kind: 'create',
					nodeId: child.id,
					parentId: parent.id,
					name: child.name,
					revision: child.revision,
					meta: child.meta,
					...(child.contentHash === undefined ? {} : { contentHash: child.contentHash })
				}
			})
			if (child.type === FileType.Directory) await walk(child, path)
		}
	}
	const root = await nodes.get(ROOT_NODE_ID)
	if (root) await walk(root, '/')
	// Path order IS parent-before-child (a parent path is a strict prefix of its
	// child's), so one sort serves both the ordering guarantee and keyset paging.
	out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
	return out.filter((e) => e.path > afterPath).slice(0, limit)
}

// ── Replica ───────────────────────────────────────────────────────────────────

/** The v2 counterpart of `SyncReplica`: detection + apply + content, node-addressed. */
export interface NodeReplica {
	nodeDeltas(
		cursor: SyncCursor,
		opts?: { excludeLocalSource?: string; limit?: number }
	): Promise<{ operations: NodeOperation[]; to: SyncCursor; done: boolean }>
	nodeScan(
		page?: SyncCursor,
		opts?: { limit?: number }
	): Promise<{
		operations: NodeOperation[]
		next?: SyncCursor
		syncCursor: SyncCursor
		done: boolean
	}>
	applyNodeOperations(
		operations: readonly NodeOperation[],
		getBlobByHash: (hash: string) => Promise<Uint8Array>,
		opts?: { source?: string }
	): Promise<void>
	getBlobByHash(hash: string): Promise<Uint8Array>
	hasBlobByHash(hash: string): Promise<boolean>
	putBlobByHash(hash: string, data: Uint8Array): Promise<void>
}

/**
 * A local node-addressed replica over a filesystem and its node-sync module.
 * Content is fetched eagerly here — before the tree references it — and NEVER for
 * a mutation that carries no hash, which is why a pure move transfers no bytes.
 */
export function nodeSyncReplica(storage: Storage, sync: NodeSyncModule): NodeReplica {
	const content = () => {
		const c = storage.caps?.content
		if (!c) throw new Error('backend exposes no content store (caps.content)')
		return c
	}
	return {
		async nodeDeltas(cursor, opts) {
			const limit = opts?.limit ?? PAGE
			const from = Number(cursor || '0')
			const rows = await sync.nodes.read(from, limit)
			const kept = rows.filter(
				(r) => !opts?.excludeLocalSource || r.localSource !== opts.excludeLocalSource
			)
			return {
				operations: kept.map((r) => r.operation),
				// The cursor advances over the RAW rows, so a fully-filtered page still
				// makes progress.
				to: String(rows[rows.length - 1]?.seq ?? from),
				done: rows.length < limit
			}
		},
		async nodeScan(page, opts) {
			const limit = opts?.limit ?? PAGE
			// `head:encodedPath` — the delta high-water is frozen at snapshot START and
			// echoed on every page, so the caller resumes `nodeDeltas(syncCursor)` with no
			// gap (an overlapping replay is idempotent).
			let head: string
			let after = ''
			if (page) {
				const i = page.indexOf(':')
				head = i < 0 ? page : page.slice(0, i)
				after = i < 0 ? '' : decodeURIComponent(page.slice(i + 1))
			} else {
				head = String(await sync.nodes.head())
			}
			const entries = await sync.snapshot(after, limit)
			const last = entries.at(-1)?.path
			const done = entries.length < limit || last === undefined
			return {
				operations: entries.length === 0 ? [] : [{ mutations: entries.map((e) => e.mutation) }],
				next: done ? undefined : `${head}:${encodeURIComponent(last)}`,
				syncCursor: head,
				done
			}
		},
		async applyNodeOperations(operations, getBlobByHash, opts) {
			const store = content()
			const mutations = mutationsOf([...operations])
			// Where each node ends up ONCE THE WHOLE BATCH HAS LANDED. A create's parent
			// can be two mutations ahead of it, and a later move can carry it across the
			// boundary, so neither the store nor a single mutation can answer this alone.
			const incoming = new Map<SyncNodeId, { parentId: SyncNodeId; name: string }>()
			for (const m of mutations)
				if (m.kind === 'create' || m.kind === 'move')
					incoming.set(m.nodeId, { parentId: m.parentId, name: m.name })
			const locate = async (id: SyncNodeId): Promise<string | null> => {
				const node = incoming.get(id) ?? (await sync.nodes.get(id))
				return node ? effectivePath(sync.nodes, node.parentId, node.name, incoming) : null
			}

			const wanted: string[] = []
			for (const m of mutations) {
				if (m.kind === 'delete') continue
				const location = await locate(m.nodeId)
				// Bytes are only ever requested for what this replica will actually hold.
				// Asking for a hash the sender can see and this replica hides would pull the
				// content past its own boundary, and an unresolvable path never applies.
				if (!location || sync.view.ignored(location)) continue
				if (m.kind !== 'move') {
					if (m.contentHash) wanted.push(m.contentHash)
					continue
				}
				// A move can bring a subtree this replica holds but does not materialise
				// back into view. The bytes are fetched HERE, before the transaction: an
				// apply is local and atomic, and cannot wait on a network.
				const moved = await sync.nodes.get(m.nodeId)
				if (!moved || moved.localIno !== null) continue
				const pending = [{ node: moved, path: location }]
				while (pending.length > 0) {
					const next = pending.pop()
					if (!next || sync.view.ignored(next.path)) continue
					if (next.node.contentHash) wanted.push(next.node.contentHash)
					for (const child of await sync.nodes.children(next.node.id))
						pending.push({ node: child, path: joinPath(next.path, child.name) })
				}
			}
			for (const hash of new Set(wanted))
				if (!(await store.hasByHash(hash))) await store.putByHash(hash, await getBlobByHash(hash))
			await sync.apply(operations, opts)
		},
		/**
		 * Serves any hash the content store holds, INCLUDING one an ignored local file
		 * put there — the same contract as the path replica, and as every
		 * content-addressed store (git, IPFS, a block server): the address IS the
		 * proof of possession, so asking for a hash means already holding the bytes
		 * it names. What it leaks is confirmation, not content.
		 *
		 * Narrowing it to hashes some live visible node references needs a hash -> node
		 * index, which the memory reference would have to answer with a full scan.
		 * That index belongs with the SQLite store, next to the authorisation that
		 * decides WHO may ask (phases 2 and 4), not here.
		 */
		async getBlobByHash(hash) {
			const blob = await content().getByHash(hash)
			if (!blob) throw new Error(`ENOENT: blob ${hash}`)
			return blob
		},
		hasBlobByHash: (hash) => content().hasByHash(hash),
		putBlobByHash: async (hash, data) => {
			await content().putByHash(hash, data)
		}
	}
}
