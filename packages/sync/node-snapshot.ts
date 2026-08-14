import { joinPath } from '@justfiles/fs/storage.shared'
import type { NodeMutation, NodeOperation, NodeState, SyncNodeId } from './node'
import { ROOT_NODE_ID } from './node'
import type { SyncCursor } from './replica'

type SnapshotEntry = { path: string; mutation: NodeMutation }

export type NodeSnapshotRestart = { status: 'restart' }
export type NodeSnapshotBusy = { status: 'busy' }

/** Memory snapshot sessions expire after five minutes without a page/blob access. */
export const NODE_SNAPSHOT_TTL_MS = 5 * 60 * 1000
const MAX_NODE_SNAPSHOTS = 4

export type NodeSnapshotPage = {
	status: 'ok'
	session: string
	operations: NodeOperation[]
	next?: string
	syncCursor: SyncCursor
	done: boolean
}

export type NodeSnapshotBlob = { status: 'ok'; data: Uint8Array } | NodeSnapshotRestart

export type NodeSnapshotClose = { status: 'ok' } | NodeSnapshotRestart

type SnapshotView = {
	entries: SnapshotEntry[]
	syncCursor: SyncCursor
	getBlob(hash: string): Promise<Uint8Array>
	close(): Promise<void>
}

/** Internal snapshot lifecycle seam implemented by node-sync storage adapters. */
export interface NodeSnapshotSessions {
	page(
		page: string | undefined,
		limit: number
	): Promise<NodeSnapshotPage | NodeSnapshotRestart | NodeSnapshotBusy>
	getBlob(session: string, hash: string): Promise<NodeSnapshotBlob>
	close(session: string): Promise<NodeSnapshotClose>
}

/** Turn one frozen live-node view into parent-first create mutations. */
export function nodeSnapshotEntries(nodes: readonly NodeState[]): SnapshotEntry[] {
	const live = nodes.filter((node) => !node.deleted)
	const byId = new Map(live.map((node) => [node.id, node]))
	const paths = new Map<SyncNodeId, string | null>([[ROOT_NODE_ID, '/']])

	function pathOf(node: NodeState): string | null {
		const known = paths.get(node.id)
		if (known !== undefined) return known
		paths.set(node.id, null)
		const parent = node.parentId === null ? undefined : byId.get(node.parentId)
		const parentPath = parent === undefined ? null : pathOf(parent)
		const path = parentPath === null ? null : joinPath(parentPath, node.name)
		paths.set(node.id, path)
		return path
	}

	const entries: SnapshotEntry[] = []
	for (const node of live) {
		if (node.id === ROOT_NODE_ID || node.parentId === null) continue
		const path = pathOf(node)
		if (path === null) continue
		entries.push({
			path,
			mutation: {
				kind: 'create',
				nodeId: node.id,
				parentId: node.parentId,
				name: node.name,
				revision: node.revision,
				meta: node.meta,
				...(node.contentHash === undefined ? {} : { contentHash: node.contentHash })
			}
		})
	}
	return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function nodeSnapshotSessions(open: () => Promise<SnapshotView>): NodeSnapshotSessions {
	type ActiveView = SnapshotView & {
		expiresAt: number
		timer?: ReturnType<typeof setTimeout>
	}
	const sessions = new Map<string, ActiveView>()
	let opening = 0

	async function release(session: string, expected?: ActiveView): Promise<void> {
		const view = sessions.get(session)
		if (!view || (expected && view !== expected)) return
		sessions.delete(session)
		if (view.timer) clearTimeout(view.timer)
		await view.close()
	}

	function touch(session: string, view: ActiveView): void {
		if (view.timer) clearTimeout(view.timer)
		view.expiresAt = Date.now() + NODE_SNAPSHOT_TTL_MS
		view.timer = setTimeout(
			() => void release(session, view).catch(() => undefined),
			NODE_SNAPSHOT_TTL_MS
		)
		;(view.timer as { unref?: () => void }).unref?.()
	}

	async function expire(): Promise<void> {
		const now = Date.now()
		for (const [session, view] of sessions) {
			if (view.expiresAt > now) continue
			await release(session, view)
		}
	}

	function decode(page: string): { session: string; after: string } | null {
		const separator = page.indexOf(':')
		if (separator < 0) return null
		try {
			return {
				session: page.slice(0, separator),
				after: decodeURIComponent(page.slice(separator + 1))
			}
		} catch {
			return null
		}
	}

	return {
		async page(page, limit) {
			if (!Number.isSafeInteger(limit) || limit < 1)
				throw new RangeError('snapshot page limit must be a positive integer')
			await expire()
			let session: string
			let after = ''
			let view: ActiveView | undefined
			if (page === undefined) {
				if (sessions.size + opening >= MAX_NODE_SNAPSHOTS) return { status: 'busy' }
				session = crypto.randomUUID()
				opening++
				try {
					view = { ...(await open()), expiresAt: Date.now() + NODE_SNAPSHOT_TTL_MS }
				} finally {
					opening--
				}
				sessions.set(session, view)
			} else {
				const cursor = decode(page)
				if (!cursor) return { status: 'restart' }
				session = cursor.session
				after = cursor.after
				view = sessions.get(session)
				if (!view) return { status: 'restart' }
			}
			touch(session, view)
			const remaining = view.entries.filter((entry) => entry.path > after).slice(0, limit + 1)
			const entries = remaining.slice(0, limit)
			const last = entries.at(-1)?.path
			const done = remaining.length <= limit
			return {
				status: 'ok',
				session,
				operations:
					entries.length === 0 ? [] : [{ mutations: entries.map((entry) => entry.mutation) }],
				...(done || last === undefined ? {} : { next: `${session}:${encodeURIComponent(last)}` }),
				syncCursor: view.syncCursor,
				done
			}
		},
		async getBlob(session, hash) {
			await expire()
			const view = sessions.get(session)
			if (!view) return { status: 'restart' }
			touch(session, view)
			return { status: 'ok', data: await view.getBlob(hash) }
		},
		async close(session) {
			await expire()
			const view = sessions.get(session)
			if (!view) return { status: 'restart' }
			await release(session, view)
			return { status: 'ok' }
		}
	}
}
