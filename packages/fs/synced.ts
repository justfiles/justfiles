import { persistedState } from './persistedState'
import type { Storage } from './storage'
import {
	type BlobStore,
	GenerationStaleError,
	isLocalOnlyPath,
	journaledChangeSource,
	localSyncReplica,
	PAGE,
	type SyncReplica,
	type SyncState
} from './sync-replica'
import type { PathChange } from './sync-wire'
import { parseVersion } from './sync-wire'
import type { Ino } from './types'
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
type RemotePeer =
	| Storage
	| ((ctx: { clientId: string; generation: () => number | undefined }) => SyncReplica)

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

// Coalescing window for the fs-level change signal: a committed local write arms
// a single push this many ms later, so a burst (an app save, an agent turn) folds
// into one sync instead of one per write.
const COALESCE_MS = 250

interface SyncLifecycle {
	flush(): Promise<void>
	destroy(): void
	pause(): void
	resume(): void
	status(): SyncStatus
	onStatusChange(fn: (status: SyncStatus) => void): () => void
	// The conflict-resolution pair — "keep theirs" / "keep mine" over the whole
	// volume. Their mechanics are asymmetric (see each), so they stay separate
	// methods: a client-only re-pull vs. a server CAS + a resilient republish.
	//
	// "Take theirs": discard this device's local replica and re-pull the server's
	// volume (the safe, client-only reset — no server coordination).
	takeTheirs(): Promise<void>
	// "Take mine": make this device's volume the new server baseline. Persists the
	// intent, CASes the server's lineage, then re-tags the journal as mine and
	// rewinds the push cursor so the ORDINARY sync loop republishes the whole
	// volume (resilient + resumable, no bespoke snapshot push) — it may take a
	// while, and a crash mid-republish resumes rather than discarding local. Other
	// devices converge as it drains. Client<->server only.
	takeMine(): Promise<void>
	// The volume lineage this replica is synced against — the `fromGeneration` an
	// app-level factory reset CAS-checks against.
	generation(): number | undefined
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

	// The server volume lineage this replica last agreed with, mirrored in memory so
	// the remote replica can stamp `x-fs-generation` on every mutating write (push
	// fencing). Kept in sync with `SyncState.generation` by `recordGeneration`.
	let knownGeneration = (await syncState.get()).generation

	// The in-flight "take mine" intent, mirrored in memory. Persisted BEFORE the
	// reset CAS so a crash mid-publish resumes/adopts (via the boot handshake)
	// instead of discarding the snapshot it meant to publish; cleared on finalize.
	let knownPending = (await syncState.get()).pendingReset

	// The sync engine's own local-only state files (`/.state/**`) are rewritten on
	// every cursor advance. Their inos are captured so the change-driven push
	// trigger can skip them — otherwise each cycle's bookkeeping write would feed
	// straight back into another push, a self-sustaining loop.
	const syncStateInos = new Set<Ino>()
	for (const p of ['/.state/clientid', '/.state/sync']) {
		try {
			syncStateInos.add((await localVol.stat(p)).ino)
		} catch {}
	}

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
			? props.remote({ clientId: id, generation: () => knownGeneration })
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
	async function push(pushCursor: string): Promise<{ to: string; done: boolean }> {
		const { changes, to, done } = await localReplica.pathDeltas(pushCursor, {
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
		return { to, done }
	}

	/**
	 * Pull remote path-changes since pullCursor and apply them locally.
	 * `excludeOrigin: id` skips changes this client authored (the server stamped
	 * our client-id as origin on push). Returns the new pullCursor to persist.
	 */
	async function pull(
		pullCursor: string
	): Promise<{ to: string; done: boolean; generation?: number }> {
		const { changes, to, done, generation } = await remoteReplica.pathDeltas(pullCursor, {
			excludeOrigin: id,
			limit: PAGE
		})
		await localReplica.applyPathChanges(changes, (h) => remoteReplica.getBlobByHash(h), {
			source: REMOTE_SOURCE
		})
		return { to, done, generation }
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
		// Drop the local journal + version tombstones the deletes just wrote: after a
		// lineage reset the server's versions aren't comparable to ours, so a leftover
		// tombstone would outrank a re-pulled put and strand that path. Owned backends
		// only; a P2P/native peer has no such state.
		await props.local.caps?.clearSyncState?.()
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
		await recordGeneration(serverGen)
	}

	/** Persist the agreed generation and mirror it for write-time stamping. */
	async function recordGeneration(generation: number): Promise<void> {
		knownGeneration = generation
		await syncState.patch({ generation })
	}

	/**
	 * Persist the agreed lineage identity alongside its generation (and mirror the
	 * generation for write-time stamping). Used when adopting a NEW volume after the
	 * identity gate client-resets — `lineageId` is not fenced on writes, so only the
	 * generation needs the in-memory mirror.
	 */
	async function recordLineage(lineageId: string, generation: number): Promise<void> {
		knownGeneration = generation
		await syncState.patch({ lineageId, generation })
	}

	async function clearPendingReset(): Promise<void> {
		knownPending = undefined
		await syncState.patch({ pendingReset: undefined })
	}

	/**
	 * "Take mine" local prep, after the server CAS bumped to `toGeneration` (via
	 * `takeMine` or crash-resume). Idempotent: adopt the generation, re-tag the
	 * whole journal as mine (the server is now empty), and rewind the push cursor so
	 * the ORDINARY loop republishes the whole volume — pulled files included, no
	 * bespoke snapshot push. `pullCursor` stays '0' to republish rather than
	 * bootstrap; `toGeneration` on the marker records prep is done.
	 */
	async function applyTakeMinePrep(toGeneration: number): Promise<void> {
		if (!knownPending) return
		await recordGeneration(toGeneration)
		await props.local.caps?.journal?.adoptAllAsLocal?.()
		knownPending = { ...knownPending, toGeneration }
		await syncState.patch({ pendingReset: knownPending, pushCursor: '0', pullCursor: '0' })
	}

	/**
	 * Crash-resume classifier for an in-flight "take mine" (pure). `resume` = our
	 * reset is the current lineage and its republish should continue; `adopt` = it
	 * completed (or never landed) so keep local + adopt the server generation;
	 * `reset-to-winner` = a newer/other reset is current, so take theirs.
	 */
	function resumeAction(
		pending: { resetId: string; fromGeneration: number; toGeneration?: number },
		server: { generation?: number; resetId?: string }
	): 'resume' | 'adopt' | 'reset-to-winner' {
		if (server.resetId === pending.resetId) return 'resume'
		if (pending.toGeneration !== undefined && server.generation === pending.toGeneration)
			return 'adopt' // ours, republish completed (flag cleared)
		if (server.generation === pending.fromGeneration) return 'adopt' // never landed — keep local
		return 'reset-to-winner'
	}

	/**
	 * The volume-lineage handshake check (client<->server only), run each cycle
	 * BEFORE touching data. First the identity gate (a different `lineageId` = a
	 * different volume ⇒ reset + adopt), then — within the same volume — the
	 * generation reconcile. Eventual-consistency: never blocks; with an in-flight
	 * `pendingReset` it resumes/adopts/resets-to-winner (see `resumeAction`).
	 */
	async function reconcileLineage(server: {
		generation?: number
		resetId?: string
		lineageId?: string
	}): Promise<void> {
		if (server.generation === undefined) return // legacy server — no lineage signal
		const state = await syncState.get()
		// Identity gate, BEFORE the generation reconcile: a different `lineageId` is a
		// genuinely DIFFERENT server volume, whose `generation` epoch is not comparable to
		// ours (both may read 1). The stored cursors were minted against another volume, so
		// discard and re-bootstrap the observed lineage — the root-cause fix for reused
		// cursors that `generation` alone can't catch.
		if (
			server.lineageId !== undefined &&
			state.lineageId !== undefined &&
			server.lineageId !== state.lineageId
		) {
			await clientReset()
			await recordLineage(server.lineageId, server.generation)
			return
		}
		// A fresh (or pre-feature) replica adopts the observed `lineageId` with no spurious
		// reset: its cursors, if any, are a legitimate migration, not a wrong-volume reuse.
		if (server.lineageId !== undefined && state.lineageId === undefined)
			await syncState.patch({ lineageId: server.lineageId })
		if (knownPending) {
			const action = resumeAction(knownPending, server)
			if (action === 'resume') {
				if (knownPending.toGeneration === undefined) await applyTakeMinePrep(server.generation)
				return // our republish continues via the ordinary push
			}
			if (action === 'reset-to-winner') await clientReset()
			await recordGeneration(server.generation)
			await clearPendingReset()
			return
		}
		await reconcileGeneration(server.generation)
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
		// generation + reset flag each cycle and adopt / resume-take-mine / client-
		// reset before touching data. Eventual-consistency: it never defers.
		if (clientServer && remoteReplica.handshake) {
			await reconcileLineage(await remoteReplica.handshake())
		}
		try {
			const state = await syncState.get()
			if (state.pullCursor === undefined) {
				const generation = await bootstrap()
				await checkMidSessionReset(generation)
				return
			}
			// Drain the whole push queue this cycle: a coalesced trigger fires once, so a
			// burst larger than one page must not strand its tail until the next poll.
			let pushCursor = state.pushCursor ?? ''
			let pushDone = false
			while (!pushDone) {
				const r = await push(pushCursor)
				pushCursor = r.to
				pushDone = r.done
				await syncState.patch({ pushCursor })
			}
			// A "take mine" republish drains over the ordinary push; once it reaches the
			// journal head (nothing left to push), signal the server to clear its advisory
			// reset flag, then drop our marker. Advisory — a failure just retries next cycle.
			if (knownPending?.toGeneration !== undefined) {
				try {
					await remoteReplica.reset?.({ mode: 'complete', resetId: knownPending.resetId })
					await clearPendingReset()
				} catch {}
			}
			// Drain every remote delta page this cycle, for the same reason.
			let pullCursor = state.pullCursor
			let pullDone = false
			let generation: number | undefined
			while (!pullDone) {
				const r = await pull(pullCursor)
				pullCursor = r.to
				pullDone = r.done
				generation = r.generation
				await syncState.patch({ pullCursor })
			}
			await checkMidSessionReset(generation)
		} catch (e) {
			// A mutating write was fenced (409 generation_stale): the server lineage
			// advanced under us. Adopt it and client-reset (reconcileGeneration does
			// both); the next cycle re-bootstraps the new baseline.
			if (e instanceof GenerationStaleError) {
				await reconcileGeneration(e.generation)
				return
			}
			throw e
		}
	}

	const RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 60_000]

	let running: Promise<void> | null = null
	let timer: ReturnType<typeof setTimeout> | null = null
	let coalesceTimer: ReturnType<typeof setTimeout> | null = null
	let unsubscribeLocal: (() => void) | undefined
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
		unsubscribeLocal?.()
		unsubscribeLocal = undefined
		if (coalesceTimer) {
			clearTimeout(coalesceTimer)
			coalesceTimer = null
		}
		if (timer) {
			clearTimeout(timer)
			timer = null
		}
	}

	// The fs-level change signal: a committed local write (any writer — user, app,
	// agent) arms a single coalesced push. Skips the sync layer's own pull-applied
	// writes (REMOTE_SOURCE) and its state-file bookkeeping (syncStateInos) so a
	// pull or a cursor advance never triggers another push.
	function scheduleProactivePush() {
		if (paused || destroyed || coalesceTimer) return
		coalesceTimer = setTimeout(() => {
			coalesceTimer = null
			void flush().catch(() => {})
		}, COALESCE_MS)
	}

	// "Take theirs": drop the local replica + cursors, then re-bootstrap from the
	// server's current lineage. The common, safe reset — purely client-side.
	async function takeTheirs(): Promise<void> {
		await clientReset()
		await flush()
	}

	/**
	 * "Take mine": publish THIS volume as the new server baseline. The intent is
	 * persisted BEFORE the CAS, so a crash anywhere after it resumes on reboot (the
	 * handshake's `resumeAction`) instead of discarding the volume it meant to
	 * publish. After the CAS the republish is just the ordinary push at the new
	 * lineage — resilient, resumable, and drained by the sync loop, which then
	 * clears the server's advisory flag.
	 */
	async function takeMine(): Promise<void> {
		const fromGeneration = knownGeneration
		if (fromGeneration === undefined) throw new Error('take mine requires a server generation')
		if (!remoteReplica.reset) throw new Error('take mine requires a client<->server peer')
		const resetId = crypto.randomUUID()
		knownPending = { resetId, fromGeneration }
		await syncState.patch({ pendingReset: knownPending })
		let toGeneration: number | undefined
		try {
			;({ generation: toGeneration } = await remoteReplica.reset({
				mode: 'adopt-mine',
				fromGeneration,
				resetId
			}))
		} catch (e) {
			await clearPendingReset() // the CAS failed/lost the race — nothing to resume
			throw e
		}
		if (toGeneration === undefined) throw new Error('reset did not return a generation')
		await applyTakeMinePrep(toGeneration)
		await flush()
	}

	const lifecycle: SyncLifecycle = {
		flush,
		pause,
		resume,
		takeTheirs,
		takeMine,
		generation: () => knownGeneration,
		destroy,
		status: () => _status,
		onStatusChange
	}

	// Kick the first sync. localFirst boots without waiting on it (the local
	// volume is the working copy); otherwise block until it settles so the first
	// read already sees synced data.
	unsubscribeLocal = props.local.caps?.subscribe?.((change) => {
		if (change.source === REMOTE_SOURCE) return
		if (syncStateInos.has(change.ino)) return
		scheduleProactivePush()
	})

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
