import type { Storage, FsOp, MutationOptions } from './storage';
import { isFsCursorExpiredError } from './storage';
import type { Ino } from './types';
import { FileType } from './types';
import { volume, type Volume } from './volume';
import { persistedState } from './persistedState';

type Props = {
	local: Storage,
	remote: Storage,
	interval?: number,
	lazyContent?: boolean,
}

type SyncState = {
	remoteCursor?: string
	localCursor?: string
}

const SYNC_XATTR_PREFIX = 'trusted.sync.'
const SYNC_LOCAL_ONLY_XATTR = `${SYNC_XATTR_PREFIX}local-only`
// Tag applied to every op the sync layer writes to local — lets push filter them out.
const REMOTE_SOURCE = 'remote'

interface SyncLifecycle {
	flush(): Promise<void>
	destroy(): void
	pause(): void
	resume(): void
}

export async function synced(props: Props): Promise<Volume & SyncLifecycle> {

	const localVol = volume(props.local)

	const syncInterval = props.interval ?? 30_000

	// Cached xattr lookups — true means the inode is local-only and excluded from sync.
	const _localOnlyCache = new Map<Ino, boolean>()

	async function isLocalOnly(ino: Ino): Promise<boolean> {
		if (_localOnlyCache.has(ino)) return _localOnlyCache.get(ino)!
		const marked = (await props.local.caps?.getXattr?.(ino, SYNC_LOCAL_ONLY_XATTR)) !== null
		_localOnlyCache.set(ino, marked ?? false)
		return marked ?? false
	}

	async function markLocalOnly(ino: Ino): Promise<void> {
		if (await isLocalOnly(ino)) return
		await props.local.caps?.setXattr?.(ino, SYNC_LOCAL_ONLY_XATTR, new Uint8Array(0), { source: REMOTE_SOURCE })
		_localOnlyCache.set(ino, true)
	}

	// Mark the .state directory and all its children as local-only.
	// Idempotent — safe to call on every sync cycle, no-ops after first run.
	async function initStateMarkers(): Promise<void> {
		if (!(await localVol.exists('/.state'))) return
		const { ino: stateIno } = await localVol.stat('/.state')
		await markLocalOnly(stateIno)
		let cursor = ''
		do {
			const { entries, next } = await props.local.listDirents(stateIno, cursor)
			await Promise.all(entries.map(e => markLocalOnly(e.ino)))
			cursor = next
		} while (cursor)
	}

	// Returns true if any inode involved in the op is marked local-only.
	async function shouldSkipOp(op: FsOp): Promise<boolean> {
		if (op.kind === 'upsert-inode') return isLocalOnly(op.ino)
		if (await isLocalOnly(op.dirIno)) return true
		if (op.kind === 'set-dirent') return isLocalOnly(op.ino)
		return op.ino != null && isLocalOnly(op.ino)
	}

	// True when local and remote both changed the same inode independently since
	// the last agreed baseline — a genuine conflict requiring resolution.
	async function hasConflict(ino: Ino, remoteHash: string | undefined): Promise<boolean> {
		if (!remoteHash) return false
		const [localMeta, baseline] = await Promise.all([props.local.getMeta(ino), getHashBaseline(ino)])
		const localHash = localMeta?.contentHash
		if (!localHash || !baseline) return false
		return localHash !== baseline && remoteHash !== baseline && localHash !== remoteHash
	}

	/**
	 * Push local changes since localCursor to remote.
	 * Tags outgoing ops with clientId as source.
	 * Returns the new localCursor to persist.
	 */
	async function push(localCursor: string, clientId: string): Promise<string> {
		if (!props.local.caps?.deltaUpdates) return localCursor
		const [{ ops, cursor }] = await Promise.all([
			// Exclude ops the sync layer wrote to local (tagged REMOTE_SOURCE) — only push user-originated writes.
			props.local.caps.deltaUpdates(localCursor, { source: REMOTE_SOURCE, sourceMode: 'exclude' }),
			initStateMarkers(),
		])
		// Tag remote writes with clientId so other clients can filter out our echoes in their pull.
		const opts: MutationOptions = { source: clientId }
		for (const op of ops) {
			if (await shouldSkipOp(op)) continue
			await applyOp(op, props.local, props.remote, opts)
			if (op.kind === 'upsert-inode' && op.meta?.contentHash) {
				await setHashBaseline(op.ino, op.meta.contentHash)
			}
		}
		return cursor
	}

	/**
	 * Pull updates from remote since remoteCursor.
	 * Skips ops originating from clientId (our own echoed writes).
	 * Returns the new remoteCursor to persist.
	 */
	async function pull(remoteCursor: string, clientId: string): Promise<string> {
		if (!props.remote.caps?.deltaUpdates) return remoteCursor
		const { ops, cursor } = await props.remote.caps.deltaUpdates(remoteCursor, { source: clientId, sourceMode: 'exclude' })
		// Tag as REMOTE_SOURCE so push knows not to re-send these back.
		const opts: MutationOptions = { source: REMOTE_SOURCE }
		for (const op of ops) {
			if (op.kind === 'upsert-inode' && await hasConflict(op.ino, op.meta?.contentHash)) {
				const localMeta = await props.local.getMeta(op.ino)
				if ((localMeta?.mtimeNs ?? 0n) >= (op.meta?.mtimeNs ?? 0n)) continue // local wins
			}
			await applyOp(op, props.remote, props.local, opts, props.lazyContent)
			if (op.kind === 'upsert-inode' && op.meta?.contentHash) {
				await setHashBaseline(op.ino, op.meta.contentHash)
			}
		}
		return cursor
	}

	/**
	 * Full download from remote via scan.
	 * Applies every remote inode and directory entry to local, sets baselines,
	 * and captures the update cursor from the scan so the next pull is incremental.
	 */
	async function bootstrap(): Promise<void> {
		if (!props.remote.caps?.fullScan) throw new Error('remote backend does not support scan — bootstrap unavailable')
		const opts: MutationOptions = { source: REMOTE_SOURCE }
		let scanCursor = ''
		let remoteCursor: string | undefined
		do {
			const result = await props.remote.caps.fullScan(scanCursor)
			if (result.syncCursor !== undefined) remoteCursor = result.syncCursor
			// TODO: reconcile — delete local dirents/inodes absent from remote snapshot
			for (const entry of result.entries) {
				await applyOp({ kind: 'upsert-inode', ino: entry.ino, meta: entry.meta, xattrs: entry.xattrs }, props.remote, props.local, opts, props.lazyContent)
				await applyOp({ kind: 'set-dirent', dirIno: entry.dirIno, name: entry.name, ino: entry.ino, type: entry.meta.type }, props.remote, props.local, opts, props.lazyContent)
				if (entry.meta.contentHash) await setHashBaseline(entry.ino, entry.meta.contentHash)
			}
			scanCursor = result.next
		} while (scanCursor)
		await syncState.patch({ remoteCursor: remoteCursor ?? '' })
	}

	const clientId = persistedState(localVol, '/.state/clientid', () => crypto.randomUUID())
	const syncState = persistedState<SyncState>(localVol, '/.state/sync', {})

	async function getHashBaseline(ino: Ino): Promise<string | null> {
		const raw = await props.local.caps?.getXattr?.(ino, `${SYNC_XATTR_PREFIX}baseline`)
		return raw ? new TextDecoder().decode(raw) : null
	}

	async function setHashBaseline(ino: Ino, hash: string): Promise<void> {
		await props.local.caps?.setXattr?.(ino, `${SYNC_XATTR_PREFIX}baseline`, new TextEncoder().encode(hash), { source: REMOTE_SOURCE })
	}

	async function sync() {
		const state = await syncState.get()
		if (!state.remoteCursor) {
			await bootstrap()
			return
		}
		const id = await clientId.get()
		try {
			const localCursor = await push(state.localCursor ?? '', id)
			await syncState.patch({ localCursor })
			const remoteCursor = await pull(state.remoteCursor, id)
			await syncState.patch({ remoteCursor })
		} catch (e) {
			if (!isFsCursorExpiredError(e)) throw e
			await syncState.patch({ remoteCursor: undefined })
			await bootstrap()
		}
	}

	const RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 60_000]

	let running: Promise<void> | null = null
	let timer: ReturnType<typeof setTimeout> | null = null
	let paused = false
	let destroyed = false
	let retryCount = 0

	function schedule() {
		if (paused || destroyed) return
		const delay = retryCount > 0
			? RETRY_DELAYS_MS[Math.min(retryCount - 1, RETRY_DELAYS_MS.length - 1)]!
			: syncInterval
		timer = setTimeout(run, delay)
	}

	function run() {
		if (running || paused || destroyed) return
		running = sync()
			.then(() => { retryCount = 0 })
			.catch((e) => { console.error(e); retryCount++ })
			.finally(() => { running = null; schedule() })
	}

	function flush(): Promise<void> {
		if (running) return running
		if (timer) { clearTimeout(timer); timer = null }
		run()
		return running ?? Promise.resolve()
	}

	function pause()   { paused = true;  if (timer) { clearTimeout(timer); timer = null } }
	function resume()  { paused = false; run() }
	function destroy() { destroyed = true; if (timer) { clearTimeout(timer); timer = null } }

	// Block until the first sync (bootstrap or incremental) completes, then start the loop.
	await sync()
	schedule()

	if (props.lazyContent) {
		// Stub inodes (created by bootstrap or pull) have no local contentHash.
		// On first read, fetch the blob from remote and cache it — putBlob then
		// sets the contentHash on the IDB inode.
		const readFile = async (path: string): Promise<Uint8Array> => {
			const stat = await localVol.stat(path)
			if (stat.type !== FileType.Regular || stat.size === 0n) return localVol.readFile(path)
			if (stat.contentHash) return localVol.readFile(path)
			// metaCache may be stale — verify against storage before fetching.
			const storedMeta = await props.local.getMeta(stat.ino)
			if (storedMeta?.contentHash) return localVol.readFile(path)
			// Genuinely not hydrated — fetch from remote.
			const data = await props.remote.getBlob(stat.ino)
			if (data.length > 0) await props.local.putBlob(stat.ino, data, { source: REMOTE_SOURCE })
			return data
		}
		return { ...localVol, readFile, flush, pause, resume, destroy }
	}

	return { ...localVol, flush, pause, resume, destroy }
}


// Apply one FsOp to target, reading file content from source when needed.
// Pass skipContent=true during bootstrap/pull to create stub inodes without
// downloading blobs — content is fetched lazily on first read instead.
async function applyOp(op: FsOp, source: Storage, target: Storage, opts: MutationOptions, skipContent = false): Promise<void> {
	switch (op.kind) {
		case 'upsert-inode': {
			const meta = skipContent && op.meta ? { ...op.meta, contentHash: undefined } : op.meta
			if (meta) await target.setMeta(op.ino, meta, opts)
			if (!skipContent && op.meta?.type === FileType.Regular) {
				const data = await source.getBlob(op.ino)
				await target.putBlob(op.ino, data, opts)
			}
			for (const [name, value] of Object.entries(op.xattrs ?? {})) {
				if (name.startsWith('trusted.sync.')) continue
				if (value === null) await target.caps?.removeXattr?.(op.ino, name, opts)
				else await target.caps?.setXattr?.(op.ino, name, value, opts)
			}
			break
		}
		case 'set-dirent': {
			const existing = await target.getDirent(op.dirIno, op.name)
			await target.putDirent(op.dirIno, op.name, { ino: op.ino, type: op.type }, opts)
			if (existing && existing.ino !== op.ino) {
				await target.deleteInode(existing.ino)
			}
			break
		}
		case 'unset-dirent': {
			const existing = await target.getDirent(op.dirIno, op.name)
			if (existing) {
				await target.deleteDirent(op.dirIno, op.name, opts)
				await target.deleteInode(existing.ino)
			}
			break
		}
	}
}
