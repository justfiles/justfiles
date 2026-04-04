import type { StorageBackend, FsOp, MutationOptions } from './storage';
import { isFsCursorExpiredError } from './storage';
import type { Ino } from './types';
import { FileType } from './types';
import { fs } from './fs';
import { volume, type Volume } from './volume';
import { persistedState } from './persistedState';

type Props = {
	local: StorageBackend,
	remote: StorageBackend,
	interval?: number,
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

	const localVol = volume(fs(props.local))

	const syncInterval = props.interval ?? 3_000

	// Cached xattr lookups — true means the inode is local-only and excluded from sync.
	const _localOnlyCache = new Map<Ino, boolean>()

	async function isLocalOnly(ino: Ino): Promise<boolean> {
		if (_localOnlyCache.has(ino)) return _localOnlyCache.get(ino)!
		const marked = (await props.local.getXattr?.(ino, SYNC_LOCAL_ONLY_XATTR)) !== null
		_localOnlyCache.set(ino, marked)
		return marked
	}

	async function markLocalOnly(ino: Ino): Promise<void> {
		if (await isLocalOnly(ino)) return
		await props.local.setXattr?.(ino, SYNC_LOCAL_ONLY_XATTR, new Uint8Array(0))
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
			const { entries, next } = await props.local.dirList(stateIno, cursor)
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
		if (!props.local.updates) return localCursor
		const [{ ops, cursor }] = await Promise.all([
			// Exclude ops the sync layer wrote to local (tagged REMOTE_SOURCE) — only push user-originated writes.
			props.local.updates(localCursor, { source: REMOTE_SOURCE, sourceMode: 'exclude' }),
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
		if (!props.remote.updates) return remoteCursor
		const { ops, cursor } = await props.remote.updates(remoteCursor, { source: clientId, sourceMode: 'exclude' })
		// Tag as REMOTE_SOURCE so push knows not to re-send these back.
		const opts: MutationOptions = { source: REMOTE_SOURCE }
		for (const op of ops) {
			if (op.kind === 'upsert-inode' && await hasConflict(op.ino, op.meta?.contentHash)) {
				const localMeta = await props.local.getMeta(op.ino)
				if ((localMeta?.mtimeNs ?? 0n) >= (op.meta?.mtimeNs ?? 0n)) continue // local wins
			}
			await applyOp(op, props.remote, props.local, opts)
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
		if (!props.remote.scan) throw new Error('remote backend does not support scan — bootstrap unavailable')
		const opts: MutationOptions = { source: REMOTE_SOURCE }
		let scanCursor = ''
		let remoteCursor: string | undefined
		do {
			const { entries, next, cursor } = await props.remote.scan(scanCursor)
			if (cursor !== undefined) remoteCursor = cursor
			for (const entry of entries) {
				await applyOp({ kind: 'upsert-inode', ino: entry.ino, meta: entry.meta }, props.remote, props.local, opts)
				await applyOp({ kind: 'set-dirent', dirIno: entry.dirIno, name: entry.name, ino: entry.ino, type: entry.meta.type }, props.remote, props.local, opts)
				if (entry.meta.contentHash) await setHashBaseline(entry.ino, entry.meta.contentHash)
			}
			scanCursor = next
		} while (scanCursor)
		await syncState.patch({ remoteCursor: remoteCursor ?? '' })
	}

	const clientId = persistedState(localVol, '/.state/clientid', () => crypto.randomUUID())
	const syncState = persistedState<SyncState>(localVol, '/.state/sync', {})

	async function getHashBaseline(ino: Ino): Promise<string | null> {
		const raw = await props.local.getXattr?.(ino, `${SYNC_XATTR_PREFIX}baseline`)
		return raw ? new TextDecoder().decode(raw) : null
	}

	async function setHashBaseline(ino: Ino, hash: string): Promise<void> {
		await props.local.setXattr?.(ino, `${SYNC_XATTR_PREFIX}baseline`, new TextEncoder().encode(hash))
	}

	async function sync() {
		const [id, state] = await Promise.all([clientId.get(), syncState.get()])
		if (!state.remoteCursor) {
			await bootstrap()
			return
		}
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

	let running: Promise<void> | null = null
	let timer: ReturnType<typeof setTimeout> | null = null
	let paused = false
	let destroyed = false

	function schedule() {
		if (paused || destroyed) return
		timer = setTimeout(run, syncInterval)
	}

	function run() {
		if (running || paused || destroyed) return
		running = sync().catch(console.error).finally(() => { running = null; schedule() })
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

	return { ...localVol, flush, pause, resume, destroy }
}


// Apply one FsOp to target, reading file content from source when needed.
async function applyOp(op: FsOp, source: StorageBackend, target: StorageBackend, opts: MutationOptions): Promise<void> {
	switch (op.kind) {
		case 'upsert-inode': {
			if (op.meta) await target.setMeta(op.ino, op.meta, opts)
			if (op.meta?.type === FileType.Regular && op.meta.size !== undefined) {
				const data = await source.read(op.ino, 0n, Number(op.meta.size))
				if (target.putBlob) await target.putBlob(op.ino, data, opts)
				else {
					await target.truncate(op.ino, op.meta.size, opts)
					if (data.length) await target.write(op.ino, 0n, data, opts)
				}
			}
			for (const [name, value] of Object.entries(op.xattrs ?? {})) {
				if (name.startsWith(SYNC_XATTR_PREFIX)) continue
				if (value === null) await target.removeXattr?.(op.ino, name, opts)
				else await target.setXattr?.(op.ino, name, value, opts)
			}
			break
		}
		case 'set-dirent':
			await target.dirSet(op.dirIno, op.name, op.ino, op.type, opts)
			break
		case 'unset-dirent':
			await target.dirUnset(op.dirIno, op.name, opts)
			break
	}
}
