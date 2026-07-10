/**
 * Layer 3 — `synced()` orchestration / lifecycle (ported to the path API).
 *
 * Drives the REAL `synced()` engine over two `memStorage` backends (two-folder
 * P2P: the `remote` backend is the shared store). These are the GREEN guardrails
 * that must keep passing after Phase 2; in Phase 1 they are RED because the
 * engine's push/pull/bootstrap call `SyncReplica` bodies that throw.
 *
 * The ino-sync-only cases (applyBatch fast-path, FsCursorExpiredError recovery)
 * were dropped when the legacy FsOp delta protocol was removed (roadmap item 1).
 */

import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { memStorage } from './storage.mem'
import type { SyncReplica } from './sync-replica'
import type { PathChange } from './sync-wire'
import { REMOTE_SOURCE, synced } from './synced'
import { FileType } from './types'
import { volume } from './volume'

const enc = new TextEncoder()
const dec = new TextDecoder()

describe('synced (lifecycle)', () => {
	const destroyers: Array<() => void> = []
	afterEach(() => {
		for (const d of destroyers.splice(0)) d()
	})
	function track<T extends { destroy(): void }>(vol: T): T {
		destroyers.push(() => vol.destroy())
		return vol
	}

	// ── Bootstrap ────────────────────────────────────────────────────────────
	it('downloads remote files to local on first start', async () => {
		const remote = memStorage()
		const remoteVol = volume(remote)
		await remoteVol.writeFile('/hello.txt', enc.encode('hello world'))
		await remoteVol.mkdir('/docs')
		await remoteVol.writeFile('/docs/readme.txt', enc.encode('readme'))

		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		expect(dec.decode(await vol.readFile('/hello.txt'))).toBe('hello world')
		expect(dec.decode(await vol.readFile('/docs/readme.txt'))).toBe('readme')
	})

	// ── Push ─────────────────────────────────────────────────────────────────
	it('pushes local writes to remote on flush', async () => {
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await vol.writeFile('/pushed.txt', enc.encode('pushed content'))
		await vol.flush()
		expect(dec.decode(await volume(remote).readFile('/pushed.txt'))).toBe('pushed content')
	})

	it('pushes a newly created directory to remote', async () => {
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await vol.mkdir('/notes')
		await vol.writeFile('/notes/idea.txt', enc.encode('idea'))
		await vol.flush()
		expect(await volume(remote).exists('/notes/idea.txt')).toBe(true)
	})

	it('pushes renames without losing content', async () => {
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await vol.writeFile('/untitled.md', enc.encode('hello'))
		await vol.flush()
		await vol.rename('/untitled.md', '/hello.md')
		await vol.flush()
		expect(await volume(remote).exists('/untitled.md')).toBe(false)
		expect(dec.decode(await volume(remote).readFile('/hello.md'))).toBe('hello')
	})

	// ── Pull ─────────────────────────────────────────────────────────────────
	it('pulls remote writes to local on flush (two clients)', async () => {
		const remote = memStorage()
		const vol1 = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		const vol2 = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await vol1.writeFile('/from-client1.txt', enc.encode('client1 data'))
		await vol1.flush()
		await vol2.flush()
		expect(dec.decode(await vol2.readFile('/from-client1.txt'))).toBe('client1 data')
	})

	it('does not echo back own pushed writes', async () => {
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await vol.writeFile('/own.txt', enc.encode('mine'))
		await vol.flush()
		const before = (await volume(remote).readdir('/')).length
		await vol.flush()
		expect((await volume(remote).readdir('/')).length).toBe(before)
	})

	it('reflects a remote file update after sync', async () => {
		const remote = memStorage()
		const remoteVol = volume(remote)
		await remoteVol.writeFile('/data.txt', enc.encode('version-1'))
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await remoteVol.writeFile('/data.txt', enc.encode('version-2'))
		await vol.flush()
		expect(dec.decode(await vol.readFile('/data.txt'))).toBe('version-2')
	})

	it('propagates file deletion from remote to local', async () => {
		const remote = memStorage()
		const remoteVol = volume(remote)
		await remoteVol.writeFile('/to-delete.txt', enc.encode('bye'))
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await remoteVol.rm('/to-delete.txt')
		await vol.flush()
		expect(await vol.exists('/to-delete.txt')).toBe(false)
	})

	// ── watch integration ──────────────────────────────────────────────────────
	it('watch fires on a remote pull tagged REMOTE_SOURCE and invalidates the cache', async () => {
		const remote = memStorage()
		const remoteVol = volume(remote)
		await remoteVol.writeFile('/state.json', enc.encode('v1'))
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		expect(Number((await vol.stat('/state.json')).size)).toBe(2)

		let fired = 0
		const sources: Array<string | undefined> = []
		await vol.watch('/state.json', (e) => {
			fired++
			sources.push(e.source)
		})
		await remoteVol.writeFile('/state.json', enc.encode('longer-version-2'))
		await vol.flush()
		await new Promise((r) => setTimeout(r, 0))
		expect(fired).toBeGreaterThanOrEqual(1)
		expect(sources).toContain(REMOTE_SOURCE)
		expect(Number((await vol.stat('/state.json')).size)).toBe('longer-version-2'.length)
	})

	// ── Local-only exclusion ────────────────────────────────────────────────────
	it('never syncs /.state to remote', async () => {
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await vol.writeFile('/x.txt', enc.encode('x'))
		await vol.flush()
		expect(await volume(remote).exists('/.state')).toBe(false)
	})

	// ── Adoption ────────────────────────────────────────────────────────────────
	it('preserves un-pushed local files when first adopting a non-empty remote', async () => {
		const remote = memStorage()
		await volume(remote).writeFile('/remote.txt', enc.encode('from remote'))
		const local = memStorage()
		await volume(local).writeFile('/local-only.txt', enc.encode('my work'))
		const vol = track(await synced({ local, remote, interval: 99_999 }))
		await vol.flush()
		expect(dec.decode(await vol.readFile('/local-only.txt'))).toBe('my work')
		expect(dec.decode(await vol.readFile('/remote.txt'))).toBe('from remote')
		expect(await volume(remote).exists('/local-only.txt')).toBe(true)
	})

	// ── Lifecycle: pause / resume / flush ─────────────────────────────────────
	it('does not push while paused and pushes on resume', async () => {
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		vol.pause()
		await vol.writeFile('/paused.txt', enc.encode('data'))
		expect(await volume(remote).exists('/paused.txt')).toBe(false)
		vol.resume()
		await vol.flush()
		expect(await volume(remote).exists('/paused.txt')).toBe(true)
	})

	it('flush() resolves only after the sync completes', async () => {
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await vol.writeFile('/check.txt', enc.encode('check'))
		await vol.flush()
		expect(await volume(remote).exists('/check.txt')).toBe(true)
	})

	it('concurrent flush() calls both resolve without error', async () => {
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await vol.writeFile('/a.txt', enc.encode('a'))
		const results = await Promise.allSettled([vol.flush(), vol.flush()])
		expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
	})

	// ── Local-first boot + status ──────────────────────────────────────────────
	it('localFirst returns the local volume immediately (write/read work at once)', async () => {
		const remote = memStorage()
		const vol = track(
			await synced({ local: memStorage(), remote, localFirst: true, interval: 99_999 })
		)
		await vol.writeFile('/note.txt', enc.encode('hi'))
		expect(dec.decode(await vol.readFile('/note.txt'))).toBe('hi')
	})

	it('reports error status when a sync fails', async () => {
		// A P2P remote whose scan rejects forces the loop into the error branch.
		const broken = memStorage()
		Object.assign(broken.caps ?? {}, {
			journal: {
				append: () => Promise.reject(new Error('boom')),
				readFrom: () => Promise.reject(new Error('boom')),
				head: () => Promise.reject(new Error('boom'))
			}
		})
		const vol = track(
			await synced({ local: memStorage(), remote: broken, localFirst: true, interval: 99_999 })
		)
		await vol.flush()
		expect(vol.status()).toBe('error')
	})

	it('notifies status subscribers as a sync settles', async () => {
		const remote = memStorage()
		const vol = track(
			await synced({ local: memStorage(), remote, localFirst: true, interval: 99_999 })
		)
		const seen: string[] = []
		vol.onStatusChange((s) => seen.push(s))
		await vol.flush()
		expect(seen).toContain('synced')
	})

	// ── Post-scan reconcile (#144 item 4) ─────────────────────────────────────
	it('re-bootstrap on an already-pushed profile reconciles local paths absent from remote, preserving /.state', async () => {
		const remote = memStorage()
		const remoteVol = volume(remote)
		await remoteVol.writeFile('/keep.txt', enc.encode('keep'))

		const local = memStorage()
		const vol1 = await synced({ local, remote, interval: 99_999 })
		await vol1.flush() // bootstrap sets pullCursor
		await vol1.writeFile('/pushed.txt', enc.encode('mine'))
		await vol1.flush() // push sets pushCursor (everPushed) + pull
		vol1.destroy()

		// A stray local path the remote never had:
		await volume(local).mkdir('/stray')
		await volume(local).writeFile('/stray/f', enc.encode('x'))

		// Force a re-bootstrap: clear pullCursor but keep pushCursor so everPushed
		// stays true and reconcile runs (deletes local paths absent from remote).
		const lv = volume(local)
		const state = JSON.parse(dec.decode(await lv.readFile('/.state/sync'))) as {
			pullCursor?: string
		}
		delete state.pullCursor
		await lv.writeFile('/.state/sync', enc.encode(JSON.stringify(state)))

		const vol2 = track(await synced({ local, remote, interval: 99_999 }))
		await vol2.flush()
		expect(await vol2.exists('/stray')).toBe(false) // reconciled away by path
		expect(await vol2.exists('/stray/f')).toBe(false)
		expect(await vol2.exists('/keep.txt')).toBe(true) // still on remote => kept
		expect(await volume(local).exists('/.state')).toBe(true) // local-only preserved
	})

	// ── Dual-source wiring, client<->server factory (#144 item 7) ─────────────
	// Asserts synced() drives PULL with excludeOrigin=clientId and stamps PUSH
	// applies with source=REMOTE_SOURCE. excludeLocalSource (local deltas) is
	// covered at the unit level (journaledChangeSource) since the local replica is
	// internal to synced(). RED now: negotiate()/bootstrap throw so push/pull never
	// run and nothing is recorded.
	it('client<->server push uses REMOTE_SOURCE and pull uses excludeOrigin=clientId', async () => {
		const deltaOpts: Array<Record<string, unknown> | undefined> = []
		const applyOpts: Array<Record<string, unknown> | undefined> = []
		const blobs = new Map<string, Uint8Array>()
		let clientId = ''
		const factory = (ctx: { clientId: string }): SyncReplica => {
			clientId = ctx.clientId
			return {
				pathScan: async () => ({ changes: [], syncCursor: '0', done: true }),
				pathDeltas: async (cursor, opts) => {
					deltaOpts.push(opts)
					return { changes: [], to: cursor || '0', done: true }
				},
				applyPathChanges: async (_changes, _getBlob, opts) => {
					applyOpts.push(opts)
				},
				getBlobByHash: async (h) => blobs.get(h) ?? new Uint8Array(),
				hasBlobByHash: async (h) => blobs.has(h),
				putBlobByHash: async (h, d) => {
					blobs.set(h, d)
				}
			}
		}
		const vol = track(await synced({ local: memStorage(), remote: factory, interval: 99_999 }))
		await vol.writeFile('/a.txt', enc.encode('hi'))
		await vol.flush() // negotiate + bootstrap
		await vol.flush() // push + pull
		expect(applyOpts.some((o) => o?.source === REMOTE_SOURCE)).toBe(true)
		expect(deltaOpts.some((o) => o?.excludeOrigin === clientId)).toBe(true)
	})
})

// ── Sync reset / generations (docs/sync-reset-generation.md, step 1) ──────────
// A controllable fake SERVER replica: it reports a `generation` on its handshake
// and echoes it on pull/scan pages, so the tests drive the engine's three-way
// handshake branch (equal / adopt / client-reset), the migration case, and the
// mid-session echo — the client-side logic the doc's step 1 specifies.

function sha256Hex(data: Uint8Array): string {
	return createHash('sha256').update(data).digest('hex')
}

type LocalBackend = ReturnType<typeof memStorage>

interface FakeServer {
	replica: SyncReplica
	generation: number | undefined
	/** Override the generation echoed on pull pages (default: `generation`). */
	deltaGeneration: number | undefined
	/** How many times the client ran a full bootstrap (pathScan) against us. */
	scanCalls: number
	seed(path: string, content: string): void
}

function fakeServer(
	init: { generation?: number; files?: Record<string, string> } = {}
): FakeServer {
	const blobs = new Map<string, Uint8Array>()
	const puts = new Map<string, PathChange>()
	const server: FakeServer = {
		generation: init.generation,
		deltaGeneration: undefined,
		scanCalls: 0,
		seed(path, content) {
			const data = enc.encode(content)
			const hash = sha256Hex(data)
			blobs.set(hash, data)
			puts.set(path, {
				kind: 'put',
				path,
				version: '1',
				contentHash: hash,
				meta: { type: FileType.Regular, mode: 0o644, mtimeNs: '0', size: String(data.length) }
			})
		},
		replica: {} as SyncReplica
	}
	for (const [p, content] of Object.entries(init.files ?? {})) server.seed(p, content)
	server.replica = {
		handshake: async () => ({ generation: server.generation }),
		pathScan: async () => {
			server.scanCalls++
			return {
				changes: [...puts.values()],
				syncCursor: '0',
				done: true,
				generation: server.generation
			}
		},
		pathDeltas: async (cursor) => ({
			changes: [],
			to: cursor || '0',
			done: true,
			generation: server.deltaGeneration ?? server.generation
		}),
		applyPathChanges: async (changes) => {
			for (const c of changes) {
				if (c.kind === 'put') puts.set(c.path, c)
				else puts.delete(c.path)
			}
		},
		getBlobByHash: async (h) => blobs.get(h) ?? new Uint8Array(),
		hasBlobByHash: async (h) => blobs.has(h),
		putBlobByHash: async (h, d) => {
			blobs.set(h, d)
		}
	}
	return server
}

async function seedSyncState(local: LocalBackend, state: Record<string, unknown>): Promise<void> {
	const vol = volume(local)
	await vol.mkdir('/.state', { recursive: true })
	await vol.writeFile('/.state/sync', enc.encode(JSON.stringify({ schemaVersion: 1, ...state })))
}

async function readSyncState(
	local: LocalBackend
): Promise<{ generation?: number; pullCursor?: string; pushCursor?: string }> {
	return JSON.parse(dec.decode(await volume(local).readFile('/.state/sync')))
}

describe('synced (generation / client-reset)', () => {
	const destroyers: Array<() => void> = []
	afterEach(() => {
		for (const d of destroyers.splice(0)) d()
	})
	function track<T extends { destroy(): void }>(vol: T): T {
		destroyers.push(() => vol.destroy())
		return vol
	}

	// stored undefined, no cursors → bootstrap, then record the generation.
	it('fresh replica bootstraps and records the server generation', async () => {
		const server = fakeServer({ generation: 5, files: { '/server.txt': 'hi' } })
		const local = memStorage()
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		expect(dec.decode(await vol.readFile('/server.txt'))).toBe('hi')
		expect((await readSyncState(local)).generation).toBe(5)
		expect(server.scanCalls).toBeGreaterThanOrEqual(1)
	})

	// equal → normal push/pull; no bootstrap, no reset.
	it('equal generation runs a normal sync (no bootstrap, no reset)', async () => {
		const server = fakeServer({ generation: 5 })
		const local = memStorage()
		await volume(local).writeFile('/keep.txt', enc.encode('mine'))
		await seedSyncState(local, { generation: 5, pullCursor: '0', pushCursor: '0' })
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		expect(await vol.exists('/keep.txt')).toBe(true)
		expect(server.scanCalls).toBe(0)
	})

	// stored undefined, HAS cursors → migration: adopt, NOT reset. This must not
	// client-reset every device that synced before `generation` existed.
	it('a pre-generation replica migrates by adopting, not resetting', async () => {
		const server = fakeServer({ generation: 7 })
		const local = memStorage()
		await volume(local).writeFile('/keep.txt', enc.encode('mine'))
		await seedSyncState(local, { pullCursor: '0', pushCursor: '0' }) // no generation
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		expect(await vol.exists('/keep.txt')).toBe(true) // preserved — a migration
		expect((await readSyncState(local)).generation).toBe(7) // adopted
		expect(server.scanCalls).toBe(0) // no re-bootstrap
	})

	// stored ≠ server (both defined) → client-reset, then record the new generation.
	it('client-resets and re-bootstraps when the server generation changes', async () => {
		const server = fakeServer({ generation: 2, files: { '/server.txt': 'theirs' } })
		const local = memStorage()
		await volume(local).writeFile('/keep.txt', enc.encode('mine'))
		await seedSyncState(local, { generation: 1, pullCursor: '0', pushCursor: '0' })
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		expect(await vol.exists('/keep.txt')).toBe(false) // discarded — take theirs
		expect(dec.decode(await vol.readFile('/server.txt'))).toBe('theirs')
		expect((await readSyncState(local)).generation).toBe(2)
		expect(server.scanCalls).toBeGreaterThanOrEqual(1)
	})

	// A pull page echoing a newer generation than the handshake triggers a reset
	// mid-session, without an extra round-trip.
	it('resets mid-session when a pull payload echoes a newer generation', async () => {
		const server = fakeServer({ generation: 5 })
		server.deltaGeneration = 6 // handshake says 5, the pull page says 6
		const local = memStorage()
		await volume(local).writeFile('/keep.txt', enc.encode('mine'))
		await seedSyncState(local, { generation: 5, pullCursor: '0', pushCursor: '0' })
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		expect(await vol.exists('/keep.txt')).toBe(false) // discarded by the echo mismatch
		expect((await readSyncState(local)).pullCursor).toBeUndefined() // cursors cleared
	})

	// A server that omits `generation` (legacy / not opted in) leaves the machinery
	// inert: normal sync, nothing recorded.
	it('ignores generation when the server omits it (legacy server)', async () => {
		const server = fakeServer({ files: { '/server.txt': 'hi' } }) // generation undefined
		const local = memStorage()
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		expect(dec.decode(await vol.readFile('/server.txt'))).toBe('hi')
		expect((await readSyncState(local)).generation).toBeUndefined()
	})
})
