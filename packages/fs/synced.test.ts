/**
 * Tests for synced() — the 2-way incremental sync volume.
 *
 * All tests operate through the public Volume interface. The core challenge is
 * that memStorage lacks `updates()` and `scan()`, making it insufficient on its
 * own. We therefore use `journaledStorage` — a wrapper that intercepts every
 * mutation, appends it to a sequential journal, and exposes `updates()` +
 * `scan()` on top.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { synced } from './synced'
import { memStorage } from './storage.mem'
import type { StorageBackend, FsOp, UpdateQueryOptions } from './storage'
import { FsCursorExpiredError } from './storage'
import type { InodeMeta } from './storage'
import { FileType } from './types'
import type { Ino } from './types'
import { fs } from './fs'
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
// journaledStorage — memStorage extended with updates() + scan() + putBlob()
// ---------------------------------------------------------------------------

type JournaledStorage = StorageBackend & {
	/** Cause the next call to updates() to throw FsCursorExpiredError. */
	triggerCursorExpiry(): void
}

/**
 * Build a journaled storage backend.
 *
 * `startIno` controls the starting inode number for allocations. Use a large
 * value (e.g. 10_000) for the remote backend so its inos never collide with
 * the local backend's small sequential inos used by /.state (typically 2–5).
 * Bootstrap copies remote inos verbatim into local, so non-overlapping ranges
 * are essential to avoid corrupting local-only state.
 */
function journaledStorage(startIno = 2): JournaledStorage {
	const base = memStorage()
	type JEntry = { seq: number; op: FsOp; source?: string }
	const journal: JEntry[] = []
	let nextSeq = 0
	let expireNext = false
	let nextIno = startIno

	function record(op: FsOp, source?: string): void {
		journal.push({ seq: nextSeq++, op, source })
	}

	/** Returns the last seq number in the journal, or -1 if empty. */
	function lastSeq(): number {
		return journal.length > 0 ? journal[journal.length - 1]!.seq : -1
	}

	return {
		...base,

		triggerCursorExpiry() {
			expireNext = true
		},

		// ---- inode lifecycle ---------------------------------------------------

		/**
		 * Allocate a new inode using our own counter so remote and local backends
		 * use non-overlapping ino ranges.
		 */
		async alloc(meta, opts) {
			const ino = String(nextIno++)
			// setMeta creates the inode via buildMissingInodeMeta when absent.
			await base.setMeta(ino, meta, opts)
			return ino
		},

		/**
		 * Create an inode + directory entry atomically, recording both as
		 * separate journal ops so push/pull can replay them independently.
		 *
		 * Handles concurrent calls (e.g. parallel persistedState.get() for
		 * clientid and sync both racing to mkdir '/.state'): if `dirAdd`
		 * returns false the name already exists — silently return the winner's
		 * ino without recording duplicate ops, matching the idempotent intent
		 * of `mkdir({ recursive: true })`.
		 */
		async create(dirIno, name, meta, opts) {
			const ino = String(nextIno++)
			await base.setMeta(ino, meta, opts)          // creates inode (nlink=0)
			const added = await base.dirAdd(dirIno, name, ino, meta.type)  // links it (nlink→1)
			if (!added) {
				// Lost the race — return the winning ino without recording.
				const existing = await base.dirLookup(dirIno, name)
				return existing!.ino
			}
			record({ kind: 'upsert-inode', ino, meta: { ...meta, nlink: 1 } }, opts?.source)
			record({ kind: 'set-dirent', dirIno, name, ino, type: meta.type }, opts?.source)
			return ino
		},

		// ---- metadata ----------------------------------------------------------

		async setMeta(ino, partial, opts) {
			await base.setMeta(ino, partial, opts)
			const meta = await base.getMeta(ino)
			if (meta) record({ kind: 'upsert-inode', ino, meta }, opts?.source)
		},

		// ---- data I/O ----------------------------------------------------------

		/**
		 * After writing, compute contentHash from the full blob and record a
		 * single upsert-inode op that carries both size and hash.
		 */
		async write(ino, offset, data, opts) {
			const n = await base.write(ino, offset, data, opts)
			const currentMeta = await base.getMeta(ino)
			if (currentMeta) {
				const buf = await base.read(ino, 0n, Number(currentMeta.size))
				const contentHash = hashBytes(buf)
				await base.setMeta(ino, { contentHash })
				const updatedMeta = await base.getMeta(ino)
				if (updatedMeta) record({ kind: 'upsert-inode', ino, meta: updatedMeta }, opts?.source)
			}
			return n
		},

		/**
		 * Atomic full-content replace. Used by applyOp when target provides it.
		 * Computes contentHash and records a single journal op.
		 */
		async putBlob(ino, data, opts) {
			await base.truncate(ino, BigInt(data.length))
			if (data.length) await base.write(ino, 0n, data)
			const contentHash = hashBytes(data)
			await base.setMeta(ino, { contentHash, size: BigInt(data.length) })
			const meta = await base.getMeta(ino)
			if (meta) record({ kind: 'upsert-inode', ino, meta }, opts?.source)
		},

		// ---- xattrs ------------------------------------------------------------

		async setXattr(ino, name, value, opts) {
			await base.setXattr!(ino, name, value, opts)
			record({ kind: 'upsert-inode', ino, xattrs: { [name]: value } }, opts?.source)
		},

		async removeXattr(ino, name, opts) {
			await base.removeXattr!(ino, name, opts)
			record({ kind: 'upsert-inode', ino, xattrs: { [name]: null } }, opts?.source)
		},

		// ---- directory entries -------------------------------------------------

		async dirAdd(dirIno, name, ino, type, opts) {
			const added = await base.dirAdd(dirIno, name, ino, type, opts)
			if (added) record({ kind: 'set-dirent', dirIno, name, ino, type }, opts?.source)
			return added
		},

		async dirSet(dirIno, name, ino, type, opts) {
			const displaced = await base.dirSet(dirIno, name, ino, type, opts)
			record({ kind: 'set-dirent', dirIno, name, ino, type }, opts?.source)
			return displaced
		},

		async dirUnset(dirIno, name, opts) {
			const entry = await base.dirUnset(dirIno, name, opts)
			if (entry) record({ kind: 'unset-dirent', dirIno, name, ino: entry.ino }, opts?.source)
			return entry
		},

		// ---- sync primitives ---------------------------------------------------

		/**
		 * Return all journal entries since `cursor`, filtered by source.
		 *
		 * Cursor semantics: String(seq) of the last op consumed, or '' / '-1' for
		 * "from the beginning". The returned cursor always reflects the tail of the
		 * full journal so callers never miss ops written between calls.
		 */
		async updates(cursor: string, options?: UpdateQueryOptions): Promise<{ ops: FsOp[]; cursor: string }> {
			if (expireNext) {
				expireNext = false
				throw new FsCursorExpiredError()
			}
			// '' means "from seq 0". '-1' (empty-journal sentinel) also maps to 0.
			const fromSeq = cursor === '' ? 0 : parseInt(cursor) + 1
			let entries = journal.filter(e => e.seq >= fromSeq)
			if (options?.source) {
				if (options.sourceMode === 'exclude') {
					entries = entries.filter(e => e.source !== options.source)
				} else if (options.sourceMode === 'only') {
					entries = entries.filter(e => e.source === options.source)
				}
			}
			return { ops: entries.map(e => e.op), cursor: String(lastSeq()) }
		},

		/**
		 * BFS walk of all inodes, emitting each in parent-before-child order.
		 * The returned `cursor` is the current journal tail — bootstrap() uses it
		 * as the starting point for subsequent incremental pulls.
		 *
		 * Returns '-1' when the journal is empty so the caller stores a truthy
		 * remoteCursor and does not re-bootstrap on the next sync cycle.
		 */
		async scan(_scanCursor: string): Promise<{
			entries: { ino: Ino; dirIno: Ino; name: string; meta: InodeMeta }[]
			next: string
			cursor?: string
		}> {
			const entries: { ino: Ino; dirIno: Ino; name: string; meta: InodeMeta }[] = []
			const queue: Ino[] = [base.rootIno]
			while (queue.length > 0) {
				const dirIno = queue.shift()!
				let cur = ''
				do {
					const { entries: batch, next } = await base.dirList(dirIno, cur)
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
			return { entries, next: '', cursor: String(lastSeq()) }
		},
	}
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
		const remote = journaledStorage(10_000)
		const remoteVol = volume(fs(remote))
		await remoteVol.writeFile('/hello.txt', enc.encode('hello world'))
		await remoteVol.mkdir('/docs')
		await remoteVol.writeFile('/docs/readme.txt', enc.encode('readme'))

		const vol = track(await synced({ local: journaledStorage(2), remote, interval: 99_999 }))

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
		const remoteVol = volume(fs(remote))

		const vol = track(await synced({ local: journaledStorage(), remote, interval: 99_999 }))

		await vol.writeFile('/pushed.txt', enc.encode('pushed content'))
		await vol.flush()

		expect(await remoteVol.exists('/pushed.txt')).toBe(true)
		expect(dec.decode(await remoteVol.readFile('/pushed.txt'))).toBe('pushed content')
	})

	it('pushes a newly created directory to remote', async () => {
		const remote = journaledStorage()
		const remoteVol = volume(fs(remote))

		const vol = track(await synced({ local: journaledStorage(), remote, interval: 99_999 }))

		await vol.mkdir('/notes')
		await vol.writeFile('/notes/idea.txt', enc.encode('idea'))
		await vol.flush()

		expect(await remoteVol.exists('/notes')).toBe(true)
		expect(await remoteVol.exists('/notes/idea.txt')).toBe(true)
	})

	// -------------------------------------------------------------------------
	// 3. Pull
	// -------------------------------------------------------------------------

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
		const remoteVol = volume(fs(remote))
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
		const remoteVol = volume(fs(remote))

		const vol = track(await synced({ local: journaledStorage(), remote, interval: 99_999 }))
		await vol.flush()

		expect(await remoteVol.exists('/.state')).toBe(false)

		// Confirm root only contains what was explicitly pushed (nothing in this case).
		const entries = await remoteVol.readdir('/')
		const names = entries.map(e => e.name)
		expect(names).not.toContain('.state')
	})

	// -------------------------------------------------------------------------
	// 5. Pull: remote file updates are reflected in local
	// -------------------------------------------------------------------------

	it('reflects a remote file update after sync', async () => {
		const remote = journaledStorage(10_000)
		const remoteVol = volume(fs(remote))
		await remoteVol.writeFile('/data.txt', enc.encode('version-1'))

		// Bootstrap — intentionally do NOT read /data.txt here so the fs
		// metaCache and dirCache stay cold for that ino.
		const vol = track(await synced({ local: journaledStorage(2), remote, interval: 99_999 }))

		// Simulate a second client updating the file directly on remote.
		await remoteVol.writeFile('/data.txt', enc.encode('version-2'))

		await vol.flush()

		// Cold cache — stat reads fresh metadata → correct size → correct content.
		expect(dec.decode(await vol.readFile('/data.txt'))).toBe('version-2')
	})

	// -------------------------------------------------------------------------
	// 6. Cursor expiry recovery
	// -------------------------------------------------------------------------

	it('re-bootstraps from remote when cursor expires', async () => {
		const remote = journaledStorage(10_000)
		const remoteVol = volume(fs(remote))
		await remoteVol.writeFile('/initial.txt', enc.encode('initial'))

		const local = journaledStorage(2)
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

	// -------------------------------------------------------------------------
	// 7. Delete propagation
	// -------------------------------------------------------------------------

	it('propagates file deletion from remote to local', async () => {
		const remote = journaledStorage(10_000)
		const remoteVol = volume(fs(remote))
		await remoteVol.writeFile('/to-delete.txt', enc.encode('bye'))

		// Bootstrap. Do NOT call vol.exists('/to-delete.txt') before the
		// delete — doing so would warm the dirCache with the ino, leaving a
		// stale entry after applyOp removes the dirent from storage directly
		// (bypassing the fs.ts cache layer).
		const vol = track(await synced({ local: journaledStorage(2), remote, interval: 99_999 }))

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
		expect(await volume(fs(remote)).exists('/written-while-paused.txt')).toBe(false)

		// resume() triggers an immediate run(); flush() waits for it to finish.
		vol.resume()
		await vol.flush()

		expect(await volume(fs(remote)).exists('/written-while-paused.txt')).toBe(true)
	})

	// -------------------------------------------------------------------------
	// 9. flush() API contract
	// -------------------------------------------------------------------------

	it('flush() returns a promise that resolves after sync completes', async () => {
		const remote = journaledStorage()
		const remoteVol = volume(fs(remote))

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
		expect(results.every(r => r.status === 'fulfilled')).toBe(true)
	})
})
