import { persistedState } from './persistedState'
import type { Storage } from './storage'
import {
	type BlobStore,
	isLocalOnlyPath,
	journaledChangeSource,
	localSyncReplica,
	PAGE,
	type SyncReplica,
	type SyncState
} from './sync-replica'
import type { PathChange } from './sync-wire'
import { parseVersion } from './sync-wire'
import { FileType } from './types'
import { type Volume, volume } from './volume'

/**
 * The peer this volume syncs against. Two topologies:
 *
 * - `Storage` — a second LOCAL backend => two-folder P2P. Wrapped here in a
 *   local `SyncReplica` (composing a journaled `ChangeSource`). Origins
 *   self-stamp, blobs are read directly, no handshake.
 * - `(ctx) => SyncReplica` — the CLIENT<->SERVER case. The app injects an HTTP
 *   `remoteSyncReplica(client, { clientId })` (from `@justfiles/core`, which
 *   `packages/fs` must NOT import — core depends on fs). It is built with the
 *   `clientId` THIS volume owns, so the server stamps a matching origin and
 *   pull's `excludeOrigin` lines up. This factory seam is exactly why `Storage`
 *   stayed lean and the wire lives in a separate adapter.
 */
type RemotePeer = Storage | ((ctx: { clientId: string }) => SyncReplica)

type Props = {
	local: Storage
	remote: RemotePeer
	interval?: number
	lazyContent?: boolean
	// Local-first boot: return the local volume immediately and run the first
	// sync in the background, instead of blocking boot until it settles.
	localFirst?: boolean
}

// What the sync loop knows about replication. Network/auth states (offline,
// unauthenticated) are layered on top by the app, which holds those signals.
export type SyncStatus = 'connecting' | 'syncing' | 'synced' | 'error'

// Tag applied to every change the sync layer applies locally from a pull — lets
// push filter them out (excludeLocalSource), and lets `volume.watch` listeners
// tell remote-applied pulls from their own local writes.
export const REMOTE_SOURCE = 'remote'

// This design is v1; future breaking changes bump SyncState.schemaVersion.
const SCHEMA_VERSION = 1

interface SyncLifecycle {
	flush(): Promise<void>
	destroy(): void
	pause(): void
	resume(): void
	status(): SyncStatus
	onStatusChange(fn: (status: SyncStatus) => void): () => void
}

export async function synced(props: Props): Promise<Volume & SyncLifecycle> {
	const localVol = volume(props.local)
	const syncInterval = props.interval ?? 30_000
	const lazyContent = props.lazyContent ?? false

	const clientId = persistedState(localVol, '/.state/clientid', () => crypto.randomUUID())
	const syncState = persistedState<SyncState>(localVol, '/.state/sync', {
		schemaVersion: SCHEMA_VERSION
	})

	const id = await clientId.get()

	// The local replica always wraps props.local (a journaled backend).
	const localReplica = localSyncReplica(props.local, journaledChangeSource(props.local), {
		lazyContent,
		localActorId: id
	})

	// Topology selection — the ONE place client<->server differs from P2P. Both
	// yield a `SyncReplica`, so push/pull/bootstrap below are topology-agnostic.
	//   - factory  => CLIENT<->SERVER: an HTTP replica speaking the /fs path wire
	//     (GET /fs/path/changes, PUT /fs/blob/:hash, POST /fs/path/changes, ...),
	//     built with the clientId we own so the server-stamped origin matches
	//     pull's `excludeOrigin`.
	//   - Storage  => TWO-FOLDER P2P: wrap the local backend in a local replica.
	const clientServer = typeof props.remote === 'function'
	const remoteReplica: SyncReplica =
		typeof props.remote === 'function'
			? props.remote({ clientId: id })
			: localSyncReplica(props.remote, journaledChangeSource(props.remote), {
					lazyContent,
					localActorId: id
				})

	// The client<->server handshake, run ONCE before the first sync. A local peer
	// shares this build so P2P skips it (see `sync()`).
	let negotiated = false
	async function negotiate(): Promise<void> {
		// Forward-compat placeholder for a one-time protocol/schema probe. The
		// volume-lineage `generation` rides the per-cycle `handshake()` seam below
		// (it must be re-checked every sync, not once), so it is handled there, not
		// here. Endpoints/paths are otherwise stable, so there is nothing to
		// negotiate yet; branch here when a protocol/schema bump needs it.
	}

	/**
	 * Push local path-changes since pushCursor to the remote.
	 *
	 * CLIENT<->SERVER protocol (the server can't be fetched from, so content goes
	 * up first): `uploadBlobs` does `PUT /fs/blob/:hash` for each new hash, THEN
	 * `applyPathChanges` does `POST /fs/path/changes`; the server verifies each
	 * hash exists before accepting the put. `excludeLocalSource: REMOTE_SOURCE`
	 * skips changes the sync layer itself applied from a pull. Returns the new
	 * pushCursor to persist. (For P2P the same calls hit a local replica.)
	 */
	async function push(pushCursor: string): Promise<string> {
		const { changes, to } = await localReplica.pathDeltas(pushCursor, {
			excludeLocalSource: REMOTE_SOURCE,
			limit: PAGE
		})
		await uploadBlobs(changes, localReplica, remoteReplica)
		// Origin (PathChange.source) is stamped server-side from our clientId header
		// (the HTTP replica sends it); `source: REMOTE_SOURCE` is the LOCAL-apply tag
		// the remote records so it never bounces our write back.
		await remoteReplica.applyPathChanges(changes, (h) => remoteReplica.getBlobByHash(h), {
			source: REMOTE_SOURCE
		})
		return to
	}

	/**
	 * Pull remote path-changes since pullCursor and apply them locally.
	 * `excludeOrigin: id` skips changes this client authored (the server stamped
	 * our client-id as origin on push). Returns the new pullCursor to persist.
	 */
	async function pull(pullCursor: string): Promise<{ to: string; generation?: number }> {
		const { changes, to, generation } = await remoteReplica.pathDeltas(pullCursor, {
			excludeOrigin: id,
			limit: PAGE
		})
		await localReplica.applyPathChanges(changes, (h) => remoteReplica.getBlobByHash(h), {
			source: REMOTE_SOURCE
		})
		return { to, generation }
	}

	/**
	 * Full download from the remote via pathScan. Pages through the snapshot,
	 * applying each page locally, then resumes deltas from the frozen syncCursor.
	 * The adoption guard only reconciles (deletes local paths absent from the
	 * remote snapshot) once this profile has pushed at least once.
	 */
	async function bootstrap(): Promise<number | undefined> {
		const everPushed = (await syncState.get()).pushCursor !== undefined
		const remotePaths = new Set<string>()
		let page: string | undefined
		let syncCursor = ''
		let generation: number | undefined
		do {
			const result = await remoteReplica.pathScan(page, { limit: PAGE })
			syncCursor = result.syncCursor
			generation = result.generation
			// Adoption keep-local: on a FIRST bootstrap (never pushed), a path that
			// already exists locally WINS — keep its content and re-stamp it above the
			// remote version (via the version seam) so our next push overwrites the
			// remote loser. Skip applying the remote change for it; remote-only paths
			// are adopted normally.
			const toApply: PathChange[] = []
			for (const c of result.changes) {
				remotePaths.add(c.path)
				if (!everPushed && (await localVol.exists(c.path))) {
					const st = await localVol.stat(c.path)
					await props.local.setMeta(st.ino, {}, { version: parseVersion(c.version) + 1 })
					continue
				}
				toApply.push(c)
			}
			await localReplica.applyPathChanges(toApply, (h) => remoteReplica.getBlobByHash(h), {
				source: REMOTE_SOURCE
			})
			page = result.done ? undefined : result.next
		} while (page)
		if (everPushed) await reconcileLocal(remotePaths)
		// Resume deltas at the frozen high-water — idempotent overlap covers gaps.
		await syncState.patch({ pullCursor: syncCursor })
		return generation
	}

	/**
	 * Delete local paths absent from the remote snapshot (child-before-parent),
	 * skipping the local-only `/.state` subtree. Path-keyed (today's ino-based
	 * reconcile is replaced).
	 */
	async function reconcileLocal(remotePaths: Set<string>): Promise<void> {
		// Delete local paths absent from the remote snapshot, child-before-parent,
		// skipping the local-only /.state subtree.
		const localPaths: string[] = []
		async function walk(dir: string): Promise<void> {
			for (const e of await localVol.readdir(dir)) {
				const p = dir === '/' ? `/${e.name}` : `${dir}/${e.name}`
				if (isLocalOnlyPath(p)) continue
				localPaths.push(p)
				if (e.type === FileType.Directory) await walk(p)
			}
		}
		await walk('/')
		const absent = localPaths
			.filter((p) => !remotePaths.has(p))
			.sort((a, b) => b.split('/').length - a.split('/').length)
		for (const p of absent) await localVol.rm(p, { recursive: true, force: true })
	}

	/**
	 * "Take theirs": discard this device's local replica and re-pull. Delete every
	 * synced path (keeping the local-only `/.state` subtree), then clear the cursors
	 * so the next cycle re-bootstraps fresh against the current server lineage. The
	 * cleared `pushCursor` also resets `everPushed`, so the re-bootstrap adopts the
	 * server verbatim (nothing local left to keep).
	 */
	async function clientReset(): Promise<void> {
		for (const entry of await localVol.readdir('/')) {
			const p = `/${entry.name}`
			if (isLocalOnlyPath(p)) continue
			await localVol.rm(p, { recursive: true, force: true })
		}
		await syncState.patch({ pullCursor: undefined, pushCursor: undefined })
	}

	/**
	 * The volume-lineage handshake check (client<->server only). Compares the
	 * server's `generation` to the one this replica last agreed with:
	 * - `serverGen` undefined → legacy server, no lineage signal → normal sync.
	 * - equal → in-lineage → normal push/pull.
	 * - stored undefined → adopt the server's generation (a fresh replica bootstraps
	 *   normally; a replica that synced BEFORE `generation` existed is a MIGRATION,
	 *   not a reset — it keeps its cursors and continues).
	 * - stored ≠ server (both defined) → the lineage was reset → `clientReset` then
	 *   adopt the new generation.
	 */
	async function reconcileGeneration(serverGen?: number): Promise<void> {
		if (serverGen === undefined) return
		const state = await syncState.get()
		if (state.generation === serverGen) return
		if (state.generation !== undefined) await clientReset()
		await syncState.patch({ generation: serverGen })
	}

	/**
	 * Mid-session guard: a pull/scan page echoes the server's live `generation`. If
	 * it changed since our handshake (server reset mid-cycle), discard now; the next
	 * handshake records the new lineage and re-bootstraps. No extra round-trip.
	 */
	async function checkMidSessionReset(observed?: number): Promise<void> {
		if (observed === undefined) return
		const stored = (await syncState.get()).generation
		if (stored !== undefined && observed !== stored) await clientReset()
	}

	async function sync() {
		// CLIENT<->SERVER: negotiate the wire/state versions once, before the first
		// sync. P2P (a local peer sharing this build) skips it.
		if (clientServer && !negotiated) {
			await negotiate()
			negotiated = true
		}
		// Volume-lineage reconcile (client<->server only): read the server's
		// generation each cycle and adopt / client-reset before touching data.
		if (clientServer && remoteReplica.handshake) {
			const { generation } = await remoteReplica.handshake()
			await reconcileGeneration(generation)
		}
		const state = await syncState.get()
		if (state.pullCursor === undefined) {
			const generation = await bootstrap()
			await checkMidSessionReset(generation)
			return
		}
		const pushCursor = await push(state.pushCursor ?? '')
		await syncState.patch({ pushCursor })
		const { to, generation } = await pull(state.pullCursor)
		await syncState.patch({ pullCursor: to })
		await checkMidSessionReset(generation)
	}

	const RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 60_000]

	let running: Promise<void> | null = null
	let timer: ReturnType<typeof setTimeout> | null = null
	let paused = false
	let destroyed = false
	let retryCount = 0
	let flushQueued: Promise<void> | null = null

	let _status: SyncStatus = 'connecting'
	const statusListeners = new Set<(status: SyncStatus) => void>()
	function setStatus(next: SyncStatus): void {
		if (_status === next) return
		_status = next
		for (const fn of statusListeners) fn(next)
	}
	function onStatusChange(fn: (status: SyncStatus) => void): () => void {
		statusListeners.add(fn)
		return () => statusListeners.delete(fn)
	}

	function schedule() {
		if (paused || destroyed) return
		const retryDelay = RETRY_DELAYS_MS[Math.min(retryCount - 1, RETRY_DELAYS_MS.length - 1)]
		const delay = retryCount > 0 && retryDelay !== undefined ? retryDelay : syncInterval
		timer = setTimeout(run, delay)
	}

	function run() {
		if (running || paused || destroyed) return
		setStatus('syncing')
		running = sync()
			.then(() => {
				retryCount = 0
				setStatus('synced')
			})
			.catch((e) => {
				console.error(e)
				retryCount++
				setStatus('error')
			})
			.finally(() => {
				running = null
				schedule()
			})
	}

	// Request an immediate push+pull and resolve once writes made *before* this
	// call have synced. If a sync is already in flight (it may predate those
	// writes), chain one more after it; concurrent callers share that follow-up.
	function flush(): Promise<void> {
		if (running) {
			flushQueued ??= running.then(() => {
				flushQueued = null
				return flush()
			})
			return flushQueued
		}
		if (timer) {
			clearTimeout(timer)
			timer = null
		}
		run()
		return running ?? Promise.resolve()
	}

	function pause() {
		paused = true
		if (timer) {
			clearTimeout(timer)
			timer = null
		}
	}
	function resume() {
		paused = false
		run()
	}
	function destroy() {
		destroyed = true
		if (timer) {
			clearTimeout(timer)
			timer = null
		}
	}

	const lifecycle: SyncLifecycle = {
		flush,
		pause,
		resume,
		destroy,
		status: () => _status,
		onStatusChange
	}

	// Kick the first sync. localFirst boots without waiting on it (the local
	// volume is the working copy); otherwise block until it settles so the first
	// read already sees synced data.
	if (props.localFirst) run()
	else await flush()

	if (lazyContent) {
		// Stubs created by bootstrap/pull retain the desired remote contentHash but
		// no local blob. On first read, hydrate by hash and store it locally.
		const readFile = async (path: string): Promise<Uint8Array> => {
			const stat = await localVol.stat(path)
			if (stat.type !== FileType.Regular || stat.size === 0n) return localVol.readFile(path)
			if (!stat.contentHash) return localVol.readFile(path)
			if (await localReplica.hasBlobByHash(stat.contentHash)) return localVol.readFile(path)
			const data = await remoteReplica.getBlobByHash(stat.contentHash)
			await localReplica.putBlobByHash(stat.contentHash, data)
			return data
		}
		return { ...localVol, readFile, ...lifecycle }
	}

	return { ...localVol, ...lifecycle }
}

/**
 * Ensure the target replica holds a blob for every regular-file put's
 * contentHash — upload from the source replica when missing. Content is durable
 * before the tree points at it.
 */
async function uploadBlobs(
	changes: PathChange[],
	source: BlobStore,
	target: BlobStore
): Promise<void> {
	for (const c of changes) {
		if (c.kind !== 'put' || !c.contentHash) continue
		if (await target.hasBlobByHash(c.contentHash)) continue
		await target.putBlobByHash(c.contentHash, await source.getBlobByHash(c.contentHash))
	}
}
