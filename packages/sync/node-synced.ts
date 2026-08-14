import { type Volume, volume } from '@justfiles/fs'
import type { PersistedState } from '@justfiles/fs/persistedState'
import type { Storage, StorageCapabilities } from '@justfiles/fs/storage'
import {
	IgnoreProtocolError,
	type IgnoreSubscriptionPolicy,
	type NodeReplica,
	nodeSyncReplica,
	type SyncCapability
} from './node'
import type { IgnorePolicy } from './policy'
import { PAGE, type SyncState } from './replica'
import { REMOTE_SOURCE, type SyncLifecycle, type SyncStatus } from './synced'

type Props = {
	local: Storage
	remote: NodeReplica
	clientId: string
	localPolicy: IgnorePolicy
	state: PersistedState<SyncState>
	interval: number
	localFirst: boolean
}

type SyncCaps = StorageCapabilities & { sync?: SyncCapability }
type ReconcileProgress = NonNullable<SyncState['reconcile']>

function covers(policy: IgnoreSubscriptionPolicy, roots: readonly string[]): boolean {
	return roots.every((root) =>
		policy.effectiveIgnore.some(
			(effective) => root === effective || root.startsWith(`${effective}/`)
		)
	)
}

export async function nodeSynced(props: Props): Promise<Volume & SyncLifecycle> {
	const localVol = volume(props.local)
	let localReplica: NodeReplica | undefined
	let policy: IgnoreSubscriptionPolicy | undefined

	async function open(): Promise<void> {
		if (localReplica) return
		policy = await props.remote.subscription()
		if (!covers(policy, props.localPolicy.roots)) throw new IgnoreProtocolError()
		const sync = (props.local.caps as SyncCaps | undefined)?.sync
		if (!sync) throw new Error('node sync requires caps.sync')
		sync.setLocalIgnore(['/.state', ...policy.effectiveIgnore])
		localReplica = nodeSyncReplica(
			sync.project(['/.state', ...policy.effectiveIgnore]),
			props.local.caps?.content
		)
	}

	async function localHead(): Promise<string> {
		if (!localReplica) throw new Error('node sync is not open')
		let cursor = ''
		let done = false
		while (!done) {
			const page = await localReplica.nodeDeltas(cursor, { limit: PAGE })
			cursor = page.to
			done = page.done
		}
		return cursor
	}

	async function localCreatesAfter(cursor: string): Promise<Set<string>> {
		if (!localReplica) throw new Error('node sync is not open')
		const ids = new Set<string>()
		let done = false
		while (!done) {
			const page = await localReplica.nodeDeltas(cursor, {
				excludeLocalSource: REMOTE_SOURCE,
				limit: PAGE
			})
			for (const operation of page.operations)
				for (const mutation of operation.mutations)
					if (mutation.kind === 'create') ids.add(mutation.nodeId)
			cursor = page.to
			done = page.done
		}
		return ids
	}

	async function snapshot(
		progress: ReconcileProgress,
		pushCursor: string
	): Promise<{
		localCursor: string
		remoteCursor: string
	}> {
		if (!localReplica?.reconcileNodeSnapshot)
			throw new Error('node sync does not support snapshot reconciliation')
		const localCursor = progress.cursor ?? (await localHead())
		progress = { ...progress, cursor: localCursor }
		await props.state.patch({ reconcile: progress })
		let pageToken: string | undefined
		let session: string | undefined
		let remoteCursor = ''
		const operations: Awaited<ReturnType<NodeReplica['nodeDeltas']>>['operations'] = []
		try {
			do {
				const page = await props.remote.nodeSnapshot(pageToken, { limit: PAGE })
				if (page.status !== 'ok') throw new Error(`node snapshot ${page.status}`)
				session = page.session
				remoteCursor = page.syncCursor
				operations.push(...page.operations)
				pageToken = page.next
			} while (pageToken)
			if (!session) throw new Error('node snapshot has no session')
			const activeSession = session
			const preserveIds = await localCreatesAfter(localCursor)
			const pendingIds =
				progress.fromHash === undefined ? new Set<string>() : await localCreatesAfter(pushCursor)
			progress = { ...progress, phase: 'local' }
			await props.state.patch({ reconcile: progress })
			await localReplica.reconcileNodeSnapshot(
				operations,
				async (hash) => {
					const blob = await props.remote.getSnapshotBlob(activeSession, hash)
					if (blob.status !== 'ok') throw new Error('node snapshot restart')
					return blob.data
				},
				{
					source: REMOTE_SOURCE,
					reconcileId: progress.operationId,
					preserveIds,
					pendingIds,
					removeStale: progress.fromHash !== undefined
				}
			)
			progress = { ...progress, phase: 'remote' }
			await props.state.patch({ reconcile: progress })
			return { localCursor, remoteCursor }
		} finally {
			if (session) await props.remote.closeSnapshot(session)
		}
	}

	async function sync(): Promise<void> {
		await open()
		if (!localReplica || !policy) throw new Error('node sync is not open')
		const local = localReplica
		let state = await props.state.get()
		if (
			state.effectiveHash !== policy.effectiveHash ||
			state.remoteIdentityEpoch !== policy.identityEpoch
		) {
			let progress = state.reconcile
			if (
				progress?.toHash !== policy.effectiveHash ||
				progress.identityEpoch !== policy.identityEpoch
			) {
				progress = {
					operationId: crypto.randomUUID(),
					fromHash: state.effectiveHash,
					toHash: policy.effectiveHash,
					identityEpoch: policy.identityEpoch,
					phase: 'snapshot'
				}
				await props.state.patch({ reconcile: progress })
			}
			const { localCursor: nodePushCursor, remoteCursor: nodePullCursor } = await snapshot(
				progress,
				progress.fromHash === undefined ? '' : (state.nodePushCursor ?? '')
			)
			await props.state.patch({
				reconcile: { ...progress, phase: 'commit', cursor: nodePushCursor }
			})
			await props.state.patch({
				localHash: props.localPolicy.hash,
				effectiveIgnore: policy.effectiveIgnore,
				effectiveHash: policy.effectiveHash,
				remoteIdentityEpoch: policy.identityEpoch,
				nodePullCursor,
				nodePushCursor,
				reconcile: undefined
			})
			state = await props.state.get()
		}
		if (state.localHash !== props.localPolicy.hash) {
			await props.state.patch({ localHash: props.localPolicy.hash })
			state = await props.state.get()
		}

		let pushCursor = state.nodePushCursor ?? ''
		let pushDone = false
		while (!pushDone) {
			const page = await local.nodeDeltas(pushCursor, {
				excludeLocalSource: REMOTE_SOURCE,
				limit: PAGE
			})
			if (page.operations.length > 0)
				await props.remote.applyNodeOperations(page.operations, (hash) => local.getBlobByHash(hash))
			pushCursor = page.to
			pushDone = page.done
			await props.state.patch({ nodePushCursor: pushCursor })
		}

		let pullCursor = state.nodePullCursor ?? ''
		let pullDone = false
		while (!pullDone) {
			const page = await props.remote.nodeDeltas(pullCursor, {
				excludeLocalSource: props.clientId,
				limit: PAGE
			})
			await local.applyNodeOperations(page.operations, (hash) => props.remote.getBlobByHash(hash), {
				source: REMOTE_SOURCE
			})
			pullCursor = page.to
			pullDone = page.done
			await props.state.patch({ nodePullCursor: pullCursor })
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
			throw new Error('node takeTheirs is not available before migration')
		},
		async takeMine() {
			throw new Error('node takeMine is not available before migration')
		},
		generation: () => undefined
	}

	if (props.localFirst) run()
	else await flush()
	return { ...localVol, ...lifecycle }
}
