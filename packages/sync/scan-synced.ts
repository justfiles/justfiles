import { type Volume, volume } from '@justfiles/fs'
import type { PersistedState } from '@justfiles/fs/persistedState'
import type { ContentStore, Storage, StorageCapabilities } from '@justfiles/fs/storage'
import { joinPath } from '@justfiles/fs/storage.shared'
import { FileType } from '@justfiles/fs/types'
import {
	IgnoreProtocolError,
	type IgnoreSubscriptionPolicy,
	type NodeMutation,
	type NodeOperation,
	type NodeReplica,
	newNodeId,
	newOperationId,
	ROOT_NODE_ID
} from './node'
import { splitPath } from './path'
import type { IgnorePolicy } from './policy'
import type { SyncState } from './replica'
import { type FullScanEntry, fullScanReplica } from './scan'
import type { SyncLifecycle, SyncStatus } from './synced'

type Props = {
	local: Storage
	remote: NodeReplica
	localPolicy: IgnorePolicy
	state: PersistedState<SyncState>
	interval: number
	localFirst: boolean
}

type RemoteEntry = FullScanEntry & {
	nodeId: string
	revision: number
}

type RemoteSnapshot = {
	entries: RemoteEntry[]
	getBlobByHash(hash: string): Promise<Uint8Array>
	close(): Promise<void>
}

type SyncCaps = StorageCapabilities & { content?: ContentStore }

function covers(policy: IgnoreSubscriptionPolicy, roots: readonly string[]): boolean {
	return roots.every((root) =>
		policy.effectiveIgnore.some(
			(effective) => root === effective || root.startsWith(`${effective}/`)
		)
	)
}

function signature(entry: FullScanEntry): string {
	return JSON.stringify({ meta: entry.meta, contentHash: entry.contentHash })
}

async function readRemoteSnapshot(remote: NodeReplica): Promise<RemoteSnapshot> {
	let pageToken: string | undefined
	let session: string | undefined
	const entries: RemoteEntry[] = []
	const paths = new Map<string, string>([[ROOT_NODE_ID, '/']])
	try {
		do {
			const page = await remote.nodeSnapshot(pageToken)
			if (page.status !== 'ok') throw new Error(`node snapshot ${page.status}`)
			session = page.session
			for (const operation of page.operations)
				for (const mutation of operation.mutations) {
					if (mutation.kind !== 'create') continue
					const parentPath = paths.get(mutation.parentId)
					if (parentPath === undefined) throw new Error('node snapshot parent is missing')
					const path = joinPath(parentPath, mutation.name)
					paths.set(mutation.nodeId, path)
					entries.push({
						path,
						nodeId: mutation.nodeId,
						revision: mutation.revision,
						meta: mutation.meta,
						contentHash: mutation.contentHash
					})
				}
			pageToken = page.next
		} while (pageToken)
		if (!session) throw new Error('node snapshot has no session')
		const activeSession = session
		return {
			entries,
			async getBlobByHash(hash) {
				const blob = await remote.getSnapshotBlob(activeSession, hash)
				if (blob.status !== 'ok') throw new Error('node snapshot restart')
				return blob.data
			},
			close: () => remote.closeSnapshot(activeSession).then(() => undefined)
		}
	} catch (error) {
		if (session) await remote.closeSnapshot(session)
		throw error
	}
}

function operationsFor(
	local: readonly FullScanEntry[],
	remote: readonly RemoteEntry[],
	baselineEntries: readonly { path: string; signature: string }[] | undefined
): NodeOperation[] {
	const localByPath = new Map(local.map((entry) => [entry.path, entry]))
	const remoteByPath = new Map(remote.map((entry) => [entry.path, entry]))
	const baseline = new Map(baselineEntries?.map((entry) => [entry.path, entry.signature]))
	const deletes = new Set<string>()
	const creates = new Set<string>()
	const updates = new Set<string>()

	for (const [path, remoteEntry] of remoteByPath) {
		const localEntry = localByPath.get(path)
		const previous = baseline.get(path)
		if (!localEntry) {
			if (previous !== undefined && signature(remoteEntry) === previous) deletes.add(path)
			continue
		}
		if (signature(localEntry) === signature(remoteEntry)) continue
		if (previous === undefined || signature(remoteEntry) !== previous) continue
		if (localEntry.meta.type === remoteEntry.meta.type) updates.add(path)
		else {
			for (const candidate of remoteByPath.keys())
				if (candidate === path || candidate.startsWith(`${path}/`)) deletes.add(candidate)
			for (const candidate of localByPath.keys())
				if (candidate === path || candidate.startsWith(`${path}/`)) creates.add(candidate)
		}
	}
	for (const path of localByPath.keys())
		if (!remoteByPath.has(path) && !baseline.has(path)) creates.add(path)

	const operations: NodeOperation[] = []
	for (const path of [...deletes].sort((a, b) => b.length - a.length)) {
		const entry = remoteByPath.get(path)
		if (!entry) continue
		const mutation: NodeMutation = {
			kind: 'delete',
			nodeId: entry.nodeId,
			baseRevision: entry.revision,
			revision: entry.revision + 1
		}
		operations.push({ operationId: newOperationId(), mutations: [mutation] })
	}

	const ids = new Map(remote.map((entry) => [entry.path, entry.nodeId]))
	ids.set('/', ROOT_NODE_ID)
	for (const path of [...creates].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
		const entry = localByPath.get(path)
		if (!entry) continue
		const { parentPath, name } = splitPath(path)
		const parentId = ids.get(parentPath)
		if (!parentId) throw new Error(`scan parent is missing: ${parentPath}`)
		const nodeId = newNodeId()
		ids.set(path, nodeId)
		const mutation: NodeMutation = {
			kind: 'create',
			nodeId,
			parentId,
			name,
			baseRevision: 0,
			revision: 1,
			meta: entry.meta,
			contentHash: entry.contentHash
		}
		operations.push({ operationId: newOperationId(), mutations: [mutation] })
	}
	for (const path of [...updates].sort()) {
		const localEntry = localByPath.get(path)
		const remoteEntry = remoteByPath.get(path)
		if (!localEntry || !remoteEntry) continue
		const mutation: NodeMutation = {
			kind: 'update',
			nodeId: remoteEntry.nodeId,
			baseRevision: remoteEntry.revision,
			revision: remoteEntry.revision + 1,
			meta: localEntry.meta,
			contentHash: localEntry.meta.type === FileType.Regular ? localEntry.contentHash : undefined
		}
		operations.push({ operationId: newOperationId(), mutations: [mutation] })
	}
	return operations
}

export async function scanSynced(props: Props): Promise<Volume & SyncLifecycle> {
	const localVolume = volume(props.local)
	let policy: IgnoreSubscriptionPolicy | undefined

	async function open(): Promise<IgnoreSubscriptionPolicy> {
		if (policy) return policy
		policy = await props.remote.subscription()
		if (!covers(policy, props.localPolicy.roots)) throw new IgnoreProtocolError()
		return policy
	}

	async function sync(): Promise<void> {
		const activePolicy = await open()
		const content = (props.local.caps as SyncCaps | undefined)?.content
		const localReplica = fullScanReplica(props.local, content, activePolicy.effectiveIgnore)
		const state = await props.state.get()
		const baseline =
			state.effectiveHash === activePolicy.effectiveHash &&
			state.remoteIdentityEpoch === activePolicy.identityEpoch
				? state.scanBaseline
				: undefined
		const local = await localReplica.scan()
		const remote = await readRemoteSnapshot(props.remote)
		try {
			const operations = operationsFor(local.entries, remote.entries, baseline)
			if (operations.length > 0)
				await props.remote.applyNodeOperations(operations, (hash) => local.getBlobByHash(hash))
		} finally {
			await local.close()
			await remote.close()
		}

		const finalRemote = await readRemoteSnapshot(props.remote)
		try {
			await localReplica.apply(finalRemote.entries, (hash) => finalRemote.getBlobByHash(hash))
			await props.state.patch({
				localHash: props.localPolicy.hash,
				effectiveIgnore: activePolicy.effectiveIgnore,
				effectiveHash: activePolicy.effectiveHash,
				remoteIdentityEpoch: activePolicy.identityEpoch,
				scanBaseline: finalRemote.entries.map((entry) => ({
					path: entry.path,
					signature: signature(entry)
				}))
			})
		} finally {
			await finalRemote.close()
		}
	}

	let running: Promise<void> | null = null
	let timer: ReturnType<typeof setTimeout> | null = null
	let paused = false
	let destroyed = false
	let currentStatus: SyncStatus = 'connecting'
	const listeners = new Set<(status: SyncStatus) => void>()

	function setStatus(status: SyncStatus): void {
		if (status === currentStatus) return
		currentStatus = status
		for (const listener of listeners) listener(status)
	}

	function schedule(): void {
		if (!paused && !destroyed) timer = setTimeout(run, props.interval)
	}

	function run(): void {
		if (running || paused || destroyed) return
		setStatus('syncing')
		running = sync()
			.then(() => setStatus('synced'))
			.catch((error) => {
				console.error(error)
				setStatus('error')
			})
			.finally(() => {
				running = null
				schedule()
			})
	}

	function flush(): Promise<void> {
		if (running) return running.then(flush)
		if (timer) clearTimeout(timer)
		timer = null
		run()
		return running ?? Promise.resolve()
	}

	const lifecycle: SyncLifecycle = {
		flush,
		destroy() {
			destroyed = true
			if (timer) clearTimeout(timer)
		},
		pause() {
			paused = true
			if (timer) clearTimeout(timer)
			timer = null
		},
		resume() {
			paused = false
			run()
		},
		status: () => currentStatus,
		onStatusChange(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		async takeTheirs() {
			throw new Error('scan takeTheirs is not available before migration')
		},
		async takeMine() {
			throw new Error('scan takeMine is not available before migration')
		},
		generation: () => undefined
	}

	if (props.localFirst) run()
	else await flush()
	return { ...localVolume, ...lifecycle }
}
