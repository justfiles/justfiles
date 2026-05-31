/**
 * Tests for synced() — the 2-way incremental sync volume.
 *
 * All tests operate through the public Volume interface. The core challenge is
 * that memStorage lacks `deltaUpdates()` and `fullScan()`, making it insufficient
 * on its own. We therefore use `journaledStorage` — a wrapper that intercepts
 * every mutation, appends it to a sequential journal, and exposes `deltaUpdates()`
 * + `fullScan()` via caps on top.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { FsOp, InodeMeta, Storage, StorageCapabilities, UpdateQueryOptions } from './storage'
import { FsCursorExpiredError } from './storage'
import { memStorage } from './storage.mem'
import { REMOTE_SOURCE, synced } from './synced'
import type { Ino } from './types'
import { FileType } from './types'
import { volume } from './volume'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Deterministic content hash: djb2 over the full buffer + length suffix. */
function hashBytes(data: Uint8Array): string {
	let h = 5381
	for (const b of data) h = ((h << 5) + h + b) & 0x7fffffff
	return `${h.toString(16)}_${data.length}`
}

// ---------------------------------------------------------------------------
// journaledStorage — memStorage extended with deltaUpdates() + fullScan() + putBlob()
// ---------------------------------------------------------------------------

type JournaledStorage = Storage & {
	/** Cause the next call to deltaUpdates() to throw FsCursorExpiredError. */
	triggerCursorExpiry(): void
}

/**
 * Build a journaled storage backend.
 *
 * Wraps memStorage and intercepts mutations to record a journal.
 * Exposes deltaUpdates() and fullScan() via caps.
 */
function journaledStorage(): JournaledStorage {
	const base = memStorage()
	type JEntry = { seq: number; op: FsOp; source?: string }
	const journal: JEntry[] = []
	let nextSeq = 0
	let expireNext = false

	function record(op: FsOp, source?: string): void {
		journal.push({ seq: nextSeq++, op, source })
	}

	/** Returns the last seq number in the journal, or -1 if empty. */
	function lastSeq(): number {
		return journal.at(-1)?.seq ?? -1
	}

	const baseCaps = base.caps
	if (!baseCaps?.getXattr || !baseCaps.setXattr || !baseCaps.listXattrs || !baseCaps.removeXattr) {
		throw new Error('journaledStorage requires xattr capabilities')
	}
	const setXattr = baseCaps.setXattr
	const removeXattr = baseCaps.removeXattr

	const caps: StorageCapabilities = {
		// Inherit xattr caps from base
		getXattr: baseCaps.getXattr,
		setXattr: async (ino, name, value, opts) => {
			await setXattr(ino, name, value, opts)
			record({ kind: 'upsert-inode', ino, xattrs: { [name]: value } }, opts?.source)
		},
		listXattrs: baseCaps.listXattrs,
		removeXattr: async (ino, name, opts) => {
			await removeXattr(ino, name, opts)
			record({ kind: 'upsert-inode', ino, xattrs: { [name]: null } }, opts?.source)
		},

		// Forward the base change feed so volume.watch works through synced.
		subscribe: baseCaps.subscribe?.bind(baseCaps),

		/**
		 * Return all journal entries since `cursor`, filtered by source.
		 */
		async deltaUpdates(
			cursor: string,
			options?: UpdateQueryOptions
		): Promise<{ ops: FsOp[]; cursor: string }> {
			if (expireNext) {
				expireNext = false
				throw new FsCursorExpiredError()
			}
			const fromSeq = cursor === '' ? 0 : parseInt(cursor, 10) + 1
			let entries = journal.filter((e) => e.seq >= fromSeq)
			if (options?.source) {
				if (options.sourceMode === 'exclude') {
					entries = entries.filter((e) => e.source !== options.source)
				} else if (options.sourceMode === 'only') {
					entries = entries.filter((e) => e.source === options.source)
				}
			}
			return { ops: entries.map((e) => e.op), cursor: String(lastSeq()) }
		},

		/**
		 * BFS walk of all inodes, emitting each in parent-before-child order.
		 * The returned `syncCursor` is the current journal tail — bootstrap() uses
		 * it as the starting point for subsequent incremental pulls.
		 */
		async fullScan(_scanCursor: string): Promise<{
			entries: { ino: Ino; dirIno: Ino; name: string; meta: InodeMeta }[]
			next: string
			syncCursor?: string
		}> {
			const entries: { ino: Ino; dirIno: Ino; name: string; meta: InodeMeta }[] = []
			const queue: Ino[] = [base.rootIno]
			while (queue.length > 0) {
				const dirIno = queue.shift()
				if (dirIno === undefined) break
				let cur = ''
				do {
					const { entries: batch, next } = await base.listDirents(dirIno, cur)
					for (const e of batch) {
						const meta = await base.getMeta(e.ino)
						if (!meta) continue
						entries.push({ ino: e.ino, dirIno, name: e.name, meta })
						if (meta.type === FileType.Directory) queue.push(e.ino)
					}
					cur = next
				} while (cur)
			}
			// Use '-1' for an empty journal so the stored remoteCursor is truthy,
			// preventing an infinite bootstrap loop.
			return { entries, next: '', syncCursor: String(lastSeq()) }
		}
	}

	const backend: JournaledStorage = {
		...base,
		caps,

		triggerCursorExpiry() {
			expireNext = true
		},

		// ---- metadata ----------------------------------------------------------

		async setMeta(ino, partial, opts) {
			await base.setMeta(ino, partial, opts)
			const meta = await base.getMeta(ino)
			if (meta) record({ kind: 'upsert-inode', ino, meta }, opts?.source)
		},

		// ---- data I/O ----------------------------------------------------------

		/**
		 * Atomic full-content replace. Computes contentHash and records a single journal op.
		 */
		async putBlob(ino, data, opts) {
			await base.putBlob(ino, data, opts)
			const contentHash = hashBytes(data)
			await base.setMeta(ino, { contentHash, size: BigInt(data.length) })
			const meta = await base.getMeta(ino)
			if (meta) record({ kind: 'upsert-inode', ino, meta: { ...meta, contentHash } }, opts?.source)
		},

		// ---- directory entries -------------------------------------------------

		async putDirent(dirIno, name, entry, opts) {
			await base.putDirent(dirIno, name, entry, opts)
			record({ kind: 'set-dirent', dirIno, name, ino: entry.ino, type: entry.type }, opts?.source)
		},

		async deleteDirent(dirIno, name, opts) {
			// Look up ino before deleting so we can record it
			const existing = await base.getDirent(dirIno, name)
			await base.deleteDirent(dirIno, name, opts)
			if (existing) record({ kind: 'unset-dirent', dirIno, name, ino: existing.ino }, opts?.source)
		}
	}

	return backend
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('synced', () => {
	// Collect destroy callbacks so every test can clean up its timer.
	const destroyers: Array<() => void> = []

	afterEach(() => {
		for (const d of destroyers.splice(0)) d()
	})

	function track<T extends { destroy(): void }>(vol: T): T {
		destroyers.push(() => vol.destroy())
		return vol
	}

	// -------------------------------------------------------------------------
	// 1. Bootstrap
	// -------------------------------------------------------------------------

	it('downloads remote files to local on first start', async () => {
		const remote = journaledStorage()
		const remoteVol = volume(remote)
		await remoteVol.writeFile('/hello.txt', enc.encode('hello world'))
		await remoteVol.mkdir('/docs')
		await remoteVol.writeFile('/docs/readme.txt', enc.encode('readme'))

		const vol = track(await synced({ local: journaledStorage(), remote, interval: 99_999 }))

		expect(await vol.exists('/hello.txt')).toBe(true)
		expect(dec.decode(await vol.readFile('/hello.txt'))).toBe('hello world')
		expect(await vol.exists('/docs/readme.txt')).toBe(true)
		expect(dec.decode(await vol.readFile('/docs/readme.txt'))).toBe('readme')
	})

	// -------------------------------------------------------------------------
	// 2. Push
	// -------------------------------------------------------------------------

	it('pushes local writes to remote on flush', async () => {
		const remote = journaledStorage()
		const remoteVol = volume(remote)

		const vol = track(await synced({ local: journaledStorage(), remote, interval: 99_999 }))

		await vol.writeFile('/pushed.txt', enc.encode('pushed content'))
		await vol.flush()

		expect(await remoteVol.exists('/pushed.txt')).toBe(true)
		expect(dec.decode(await remoteVol.readFile('/pushed.txt'))).toBe('pushed content')
	})

	it('skips applyBatch when there are no syncable local ops', async () => {
		const remote = journaledStorage()
		let batchCalls = 0
		const batched: typeof remote = {
			...remote,
			caps: {
				...remote.caps,
				async applyBatch() {
					batchCalls++
				}
			}
		}

		const vol = track(
			await synced({ local: journaledStorage(), remote: batched, interval: 99_999 })
		)
		await vol.flush()

		expect(batchCalls).toBe(0)
	})

	it('uses applyBatch on push when the remote declares it', async () => {
		const remote = journaledStorage()
		const remoteVol = volume(remote)

		// Wrap the remote with an applyBatch cap that replays ops through the same
		// backend methods, counting invocations so we can assert the fast path ran.
		let batchCalls = 0
		let lastBatchSize = 0
		const batched: typeof remote = {
			...remote,
			caps: {
				...remote.caps,
				async applyBatch(ops, getBlob, opts) {
					batchCalls++
					lastBatchSize = ops.length
					for (const op of ops) {
						if (op.kind === 'upsert-inode') {
							if (op.meta) await remote.setMeta(op.ino, op.meta, opts)
							if (op.meta?.type === FileType.Regular) {
								await remote.putBlob(op.ino, await getBlob(op.ino), opts)
							}
							for (const [name, value] of Object.entries(op.xattrs ?? {})) {
								if (name.startsWith('trusted.sync.')) continue
								if (value === null) await remote.caps?.removeXattr?.(op.ino, name, opts)
								else await remote.caps?.setXattr?.(op.ino, name, value, opts)
							}
						} else if (op.kind === 'set-dirent') {
							await remote.putDirent(op.dirIno, op.name, { ino: op.ino, type: op.type }, opts)
						} else {
							await remote.deleteDirent(op.dirIno, op.name, opts)
						}
					}
				}
			}
		}

		const vol = track(
			await synced({ local: journaledStorage(), remote: batched, interval: 99_999 })
		)

		await vol.writeFile('/batched.txt', enc.encode('via batch'))
		await vol.flush()

		expect(batchCalls).toBeGreaterThan(0)
		expect(lastBatchSize).toBeGreaterThan(0)
		expect(await remoteVol.exists('/batched.txt')).toBe(true)
		expect(dec.decode(await remoteVol.readFile('/batched.txt'))).toBe('via batch')
	})

	it('pushes a newly created directory to remote', async () => {
		const remote = journaledStorage()
		const remoteVol = volume(remote)

		const vol = track(await synced({ local: journaledStorage(), remote, interval: 99_999 }))

		await vol.mkdir('/notes')
		await vol.writeFile('/notes/idea.txt', enc.encode('idea'))
		await vol.flush()

		expect(await remoteVol.exists('/notes')).toBe(true)
		expect(await remoteVol.exists('/notes/idea.txt')).toBe(true)
	})

	it('pushes renames without deleting the moved inode', async () => {
		const remote = journaledStorage()
		const remoteVol = volume(remote)

		const vol = track(await synced({ local: journaledStorage(), remote, interval: 99_999 }))

		await vol.writeFile('/untitled.md', enc.encode('hello'))
		await vol.flush()
		await vol.rename('/untitled.md', '/hello.md')
		await vol.flush()

		expect(await remoteVol.exists('/untitled.md')).toBe(false)
		expect(await remoteVol.exists('/hello.md')).toBe(true)
		expect(dec.decode(await remoteVol.readFile('/hello.md'))).toBe('hello')
	})

	// -------------------------------------------------------------------------
	// 3. Pull
	// -------------------------------------------------------------------------

	it('keeps hydrated lazy content when an unchanged remote upsert is pulled', async () => {
		const remote = journaledStorage()
		const remoteVol = volume(remote)
		await remoteVol.writeFile('/app.js', enc.encode('console.log(1)'))

		let blobReads = 0
		const countedRemote: typeof remote = {
			...remote,
			async getBlob(ino) {
				blobReads++
				return remote.getBlob(ino)
			}
		}
		const local = journaledStorage()
		const first = track(
			await synced({ local, remote: countedRemote, lazyContent: true, interval: 99_999 })
		)

		expect(blobReads).toBe(0)
		expect(dec.decode(await first.readFile('/app.js'))).toBe('console.log(1)')
		expect(blobReads).toBe(1)
		first.destroy()

		const { ino } = await remoteVol.stat('/app.js')
		const meta = await remote.getMeta(ino)
		if (!meta) throw new Error('missing remote meta')
		await remote.setMeta(ino, meta, { source: 'dev-reinstall' })

		const second = track(
			await synced({ local, remote: countedRemote, lazyContent: true, interval: 99_999 })
		)
		expect(dec.decode(await second.readFile('/app.js'))).toBe('console.log(1)')
		expect(blobReads).toBe(1)
	})

	it('pulls remote writes to local on flush (two clients)', async () => {
		const remote = journaledStorage()

		const vol1 = track(await synced({ local: journaledStorage(), remote, interval: 99_999 }))
		const vol2 = track(await synced({ local: journaledStorage(), remote, interval: 99_999 }))

		// Client 1 writes and pushes.
		await vol1.writeFile('/from-client1.txt', enc.encode('client1 data'))
		await vol1.flush()

		// Client 2 has not yet seen this file; flush triggers pull.
		await vol2.flush()

		expect(await vol2.exists('/from-client1.txt')).toBe(true)
		expect(dec.decode(await vol2.readFile('/from-client1.txt'))).toBe('client1 data')
	})

	it('does not echo back own pushed writes', async () => {
		const remote = journaledStorage()
		const local = journaledStorage()

		const vol = track(await synced({ local, remote, interval: 99_999 }))

		await vol.writeFile('/own.txt', enc.encode('mine'))
		await vol.flush()

		// A second flush should not cause any new writes to remote.
		const remoteVol = volume(remote)
		const beforeCount = (await remoteVol.readdir('/')).length

		await vol.flush()

		const afterCount = (await remoteVol.readdir('/')).length
		expect(afterCount).toBe(beforeCount)
	})

	// -------------------------------------------------------------------------
	// 4. Local-only exclusion
	// -------------------------------------------------------------------------

	it('never syncs /.state to remote', async () => {
		const remote = journaledStorage()
		const remoteVol = volume(remote)

		const vol = track(await synced({ local: journaledStorage(), remote, interval: 99_999 }))
		await vol.flush()

		expect(await remoteVol.exists('/.state')).toBe(false)

		// Confirm root only contains what was explicitly pushed (nothing in this case).
		const entries = await remoteVol.readdir('/')
		const names = entries.map((e) => e.name)
		expect(names).not.toContain('.state')
	})

	// -------------------------------------------------------------------------
	// 5. Pull: remote file updates are reflected in local
	// -------------------------------------------------------------------------

	it('reflects a remote file update after sync', async () => {
		const remote = journaledStorage()
		const remoteVol = volume(remote)
		await remoteVol.writeFile('/data.txt', enc.encode('version-1'))

		// Bootstrap — intentionally do NOT read /data.txt here so the
		// metaCache and dirCache stay cold for that ino.
		const vol = track(await synced({ local: journaledStorage(), remote, interval: 99_999 }))

		// Simulate a second client updating the file directly on remote.
		await remoteVol.writeFile('/data.txt', enc.encode('version-2'))

		await vol.flush()

		// Cold cache — stat reads fresh metadata → correct size → correct content.
		expect(dec.decode(await vol.readFile('/data.txt'))).toBe('version-2')
	})

	it('watch fires on a remote pull and invalidates the meta cache', async () => {
		const remote = journaledStorage()
		const remoteVol = volume(remote)
		await remoteVol.writeFile('/state.json', enc.encode('v1'))

		const vol = track(await synced({ local: journaledStorage(), remote, interval: 99_999 }))
		// Warm the local meta cache so a stale stat would be observable.
		expect(Number((await vol.stat('/state.json')).size)).toBe(2)

		let fired = 0
		const sources: Array<string | undefined> = []
		await vol.watch('/state.json', (e) => {
			fired++
			sources.push(e.source)
		})

		// A second client rewrites the file on remote; pulling it must fire the
		// watcher and (the latent-bug fix) invalidate the warm meta cache.
		await remoteVol.writeFile('/state.json', enc.encode('longer-version-2'))
		await vol.flush()
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(fired).toBeGreaterThanOrEqual(1)
		expect(sources).toContain(REMOTE_SOURCE)
		expect(Number((await vol.stat('/state.json')).size)).toBe('longer-version-2'.length)
	})

	// -------------------------------------------------------------------------
	// 6. Cursor expiry recovery
	// -------------------------------------------------------------------------

	it('re-bootstraps from remote when cursor expires', async () => {
		const remote = journaledStorage()
		const remoteVol = volume(remote)
		await remoteVol.writeFile('/initial.txt', enc.encode('initial'))

		const local = journaledStorage()
		const vol = track(await synced({ local, remote, interval: 99_999 }))
		vol.pause()

		// Add another file to remote while client is paused.
		await remoteVol.writeFile('/added-later.txt', enc.encode('added later'))

		// Trigger cursor expiry on the next pull.
		remote.triggerCursorExpiry()

		// Resume — sync should catch the error, clear remoteCursor, and bootstrap.
		vol.resume()
		await vol.flush()

		expect(await vol.exists('/initial.txt')).toBe(true)
		expect(await vol.exists('/added-later.txt')).toBe(true)
	})

	it('bootstrap deletes local files absent from remote snapshot', async () => {
		const remote = journaledStorage()
		const remoteVol = volume(remote)
		await remoteVol.writeFile('/keep.txt', enc.encode('keep'))
		await remoteVol.writeFile('/gone.txt', enc.encode('will be deleted'))

		const local = journaledStorage()
		const vol = track(await synced({ local, remote, interval: 99_999 }))
		vol.pause()

		// Confirm bootstrap populated both files using a cold volume to
		// avoid warming dirCache on the synced vol (same pattern as test 7).
		expect(await volume(local).exists('/keep.txt')).toBe(true)
		expect(await volume(local).exists('/gone.txt')).toBe(true)

		// Delete /gone.txt on the remote while client is paused.
		await remoteVol.rm('/gone.txt')

		// Trigger cursor expiry so the next sync falls back to bootstrap.
		remote.triggerCursorExpiry()

		vol.resume()
		await vol.flush()

		// Cold dirCache → fresh storage lookup.
		// /keep.txt should survive, /gone.txt should be reconciled away.
		expect(await vol.exists('/keep.txt')).toBe(true)
		expect(await vol.exists('/gone.txt')).toBe(false)
	})

	it('bootstrap deletes local directories absent from remote snapshot', async () => {
		const remote = journaledStorage()
		const remoteVol = volume(remote)
		await remoteVol.mkdir('/docs')
		await remoteVol.writeFile('/docs/a.txt', enc.encode('a'))
		await remoteVol.writeFile('/root.txt', enc.encode('root'))

		const local = journaledStorage()
		const vol = track(await synced({ local, remote, interval: 99_999 }))
		vol.pause()

		// Confirm via cold volume without warming synced vol dirCache.
		expect(await volume(local).exists('/docs/a.txt')).toBe(true)

		// Remove the entire /docs tree on remote.
		await remoteVol.rm('/docs/a.txt')
		await remoteVol.rm('/docs')

		remote.triggerCursorExpiry()
		vol.resume()
		await vol.flush()

		// Cold dirCache → fresh storage lookup.
		expect(await vol.exists('/root.txt')).toBe(true)
		expect(await vol.exists('/docs')).toBe(false)
		expect(await vol.exists('/docs/a.txt')).toBe(false)
	})

	it('bootstrap does not delete local-only entries like .state', async () => {
		const remote = journaledStorage()
		const remoteVol = volume(remote)
		await remoteVol.writeFile('/data.txt', enc.encode('data'))

		const local = journaledStorage()
		const vol = track(await synced({ local, remote, interval: 99_999 }))

		// .state is created by synced() internally and should survive reconciliation.
		expect(await volume(local).exists('/.state')).toBe(true)

		// Force a re-bootstrap via cursor expiry.
		vol.pause()
		remote.triggerCursorExpiry()
		vol.resume()
		await vol.flush()

		// .state must survive — it's local-only.
		expect(await volume(local).exists('/.state')).toBe(true)
		expect(await vol.exists('/data.txt')).toBe(true)
	})

	// -------------------------------------------------------------------------
	// 7. Delete propagation
	// -------------------------------------------------------------------------

	it('propagates file deletion from remote to local', async () => {
		const remote = journaledStorage()
		const remoteVol = volume(remote)
		await remoteVol.writeFile('/to-delete.txt', enc.encode('bye'))

		// Bootstrap. Do NOT call vol.exists('/to-delete.txt') before the
		// delete — doing so would warm the dirCache with the ino, leaving a
		// stale entry after applyOp removes the dirent from storage directly
		// (bypassing the volume cache layer).
		const vol = track(await synced({ local: journaledStorage(), remote, interval: 99_999 }))

		// Delete the file on the remote side.
		await remoteVol.rm('/to-delete.txt')

		await vol.flush()

		// Cold dirCache → fresh storage lookup → entry absent → false.
		expect(await vol.exists('/to-delete.txt')).toBe(false)
	})

	// -------------------------------------------------------------------------
	// 8. Lifecycle: pause / resume
	// -------------------------------------------------------------------------

	it('does not push while paused and pushes on resume', async () => {
		const remote = journaledStorage()

		const vol = track(await synced({ local: journaledStorage(), remote, interval: 99_999 }))

		vol.pause()
		await vol.writeFile('/written-while-paused.txt', enc.encode('data'))

		// Timer cleared — no push has run. Use a fresh remote volume to avoid
		// any stale dirCache from a previous lookup.
		expect(await volume(remote).exists('/written-while-paused.txt')).toBe(false)

		// resume() triggers an immediate run(); flush() waits for it to finish.
		vol.resume()
		await vol.flush()

		expect(await volume(remote).exists('/written-while-paused.txt')).toBe(true)
	})

	// -------------------------------------------------------------------------
	// 9. flush() API contract
	// -------------------------------------------------------------------------

	it('flush() returns a promise that resolves after sync completes', async () => {
		const remote = journaledStorage()
		const remoteVol = volume(remote)

		const vol = track(await synced({ local: journaledStorage(), remote, interval: 99_999 }))

		await vol.writeFile('/check.txt', enc.encode('check'))

		// flush() must resolve only after the sync has finished.
		await vol.flush()

		// If it resolved prematurely, remote wouldn't have the file yet.
		expect(await remoteVol.exists('/check.txt')).toBe(true)
	})

	it('flush() during an in-flight sync returns the same promise', async () => {
		const remote = journaledStorage()
		const vol = track(await synced({ local: journaledStorage(), remote, interval: 99_999 }))

		await vol.writeFile('/a.txt', enc.encode('a'))

		// Kick off two concurrent flushes — both must resolve without error.
		const p1 = vol.flush()
		const p2 = vol.flush()

		const results = await Promise.allSettled([p1, p2])
		expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
	})

	// -------------------------------------------------------------------------
	// 10. Local-first boot (Phase 4a)
	// -------------------------------------------------------------------------

	it('localFirst resolves immediately even if the remote never responds', async () => {
		const remote = journaledStorage()
		const hanging: typeof remote = {
			...remote,
			caps: { ...remote.caps, fullScan: () => new Promise(() => {}) }
		}

		// Without localFirst this await would hang on the bootstrap; with it the
		// local volume is returned at once and the bootstrap runs in the background.
		const vol = track(
			await synced({
				local: journaledStorage(),
				remote: hanging,
				localFirst: true,
				interval: 99_999
			})
		)

		await vol.writeFile('/note.txt', enc.encode('hi'))
		expect(dec.decode(await vol.readFile('/note.txt'))).toBe('hi')
		expect(vol.status()).toBe('syncing')
	})

	it('reports error status when a sync fails', async () => {
		const remote = journaledStorage()
		const failing: typeof remote = {
			...remote,
			caps: { ...remote.caps, fullScan: () => Promise.reject(new Error('boom')) }
		}

		const vol = track(
			await synced({
				local: journaledStorage(),
				remote: failing,
				localFirst: true,
				interval: 99_999
			})
		)
		await vol.flush()

		expect(vol.status()).toBe('error')
	})

	it('notifies status subscribers as a sync settles', async () => {
		const remote = journaledStorage()
		const vol = track(
			await synced({ local: journaledStorage(), remote, localFirst: true, interval: 99_999 })
		)

		const seen: string[] = []
		vol.onStatusChange((s) => seen.push(s))
		await vol.flush()

		expect(seen).toContain('synced')
	})

	it('preserves un-pushed local files when first adopting a non-empty remote', async () => {
		const remote = journaledStorage()
		await volume(remote).writeFile('/remote.txt', enc.encode('from remote'))

		// A profile with local work that has never synced.
		const local = journaledStorage()
		await volume(local).writeFile('/local-only.txt', enc.encode('my work'))

		const vol = track(await synced({ local, remote, interval: 99_999 }))
		// First sync bootstraps the remote; the second push ships local work up.
		await vol.flush()

		// Adoption must not destroy un-pushed local work, and must merge remote in.
		expect(dec.decode(await vol.readFile('/local-only.txt'))).toBe('my work')
		expect(dec.decode(await vol.readFile('/remote.txt'))).toBe('from remote')
		// The local-only file is shipped up so the account gains it too.
		expect(await volume(remote).exists('/local-only.txt')).toBe(true)
	})
})
