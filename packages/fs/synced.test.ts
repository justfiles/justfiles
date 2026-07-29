/**
 * Layer 3 — `synced()` orchestration / lifecycle (ported to the path API).
 *
 * Drives the REAL `synced()` engine over two `memStorage` backends (two-folder
 * P2P: the `remote` backend is the shared store).
 *
 * The ino-sync-only cases (applyBatch fast-path, FsCursorExpiredError recovery)
 * were dropped when the legacy FsOp delta protocol was removed.
 */

import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memStorage } from './storage.mem'
import {
	GenerationStaleError,
	journaledChangeSource,
	localSyncReplica,
	PAGE,
	type SyncReplica
} from './sync-replica'
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

	it('checks a push page for missing blobs in one batch', async () => {
		const blobs = new Map<string, Uint8Array>()
		const batches: string[][] = []
		const uploads: string[] = []
		const remote: SyncReplica = {
			pathScan: async () => ({ changes: [], syncCursor: '0', done: true }),
			pathDeltas: async (cursor) => ({ changes: [], to: cursor || '0', done: true }),
			applyPathChanges: async () => {},
			getBlobByHash: async (hash) => blobs.get(hash) ?? new Uint8Array(),
			hasBlobByHash: async () => {
				throw new Error('push should not make per-blob presence checks')
			},
			missingBlobHashes: async (hashes) => {
				batches.push(hashes)
				return new Set(hashes.filter((hash) => !blobs.has(hash)))
			},
			putBlobByHash: async (hash, data) => {
				uploads.push(hash)
				blobs.set(hash, data)
			}
		}
		const vol = track(await synced({ local: memStorage(), remote: () => remote, interval: 99_999 }))

		await vol.writeFile('/a.txt', enc.encode('a'))
		await vol.writeFile('/b.txt', enc.encode('b'))
		await vol.flush()

		expect(batches).toHaveLength(1)
		expect(new Set(batches[0])).toEqual(new Set(uploads))
		expect(uploads).toHaveLength(2)
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

	// Same for reconcile: a path the peer was never allowed to have must not be deleted
	// for being "absent from the remote".
	it('reconcile keeps a host ignore the remote never had', async () => {
		const remote = memStorage()
		await volume(remote).writeFile('/keep.txt', enc.encode('keep'))
		const local = memStorage()
		const ignore = (p: string) => p.startsWith('/state/cache/')

		const vol1 = await synced({ local, remote, interval: 99_999, ignore })
		await vol1.flush()
		await vol1.writeFile('/pushed.txt', enc.encode('mine'))
		await vol1.flush() // everPushed => reconcile runs on re-bootstrap
		vol1.destroy()

		const lv = volume(local)
		await lv.mkdir('/state/cache', { recursive: true })
		await lv.writeFile('/state/cache/blob', enc.encode('MINE'))
		await lv.writeFile('/stray.md', enc.encode('x'))
		const state = JSON.parse(dec.decode(await lv.readFile('/.state/sync'))) as {
			pullCursor?: string
		}
		delete state.pullCursor
		await lv.writeFile('/.state/sync', enc.encode(JSON.stringify(state)))

		const vol2 = track(await synced({ local, remote, interval: 99_999, ignore }))
		await vol2.flush()
		expect(await vol2.exists('/stray.md')).toBe(false) // reconciled away
		expect(dec.decode(await vol2.readFile('/state/cache/blob'))).toBe('MINE')
	})

	// Host-private roots survive a destructive reconcile: the remote never had them, so
	// "absent from the remote" must not mean "delete locally".
	it('reconcile keeps the host-private root the remote never had', async () => {
		const remote = memStorage()
		await volume(remote).writeFile('/keep.txt', enc.encode('keep'))

		const local = memStorage()
		const vol1 = await synced({ local, remote, interval: 99_999 })
		await vol1.flush()
		await vol1.writeFile('/pushed.txt', enc.encode('mine'))
		await vol1.flush() // everPushed => reconcile runs on re-bootstrap
		vol1.destroy()

		const lv = volume(local)
		await lv.mkdir('/host/accounts', { recursive: true })
		await lv.writeFile('/host/accounts/cred.json', enc.encode('CRED'))
		await lv.writeFile('/stray.md', enc.encode('x'))

		const state = JSON.parse(dec.decode(await lv.readFile('/.state/sync'))) as {
			pullCursor?: string
		}
		delete state.pullCursor
		await lv.writeFile('/.state/sync', enc.encode(JSON.stringify(state)))

		const vol2 = track(await synced({ local, remote, interval: 99_999 }))
		await vol2.flush()
		expect(await vol2.exists('/stray.md')).toBe(false) // reconciled away
		expect(dec.decode(await vol2.readFile('/host/accounts/cred.json'))).toBe('CRED')
	})

	it('re-bootstrap pulls post-snapshot updates before reconciling missing paths', async () => {
		const remote = memStorage()
		const remoteVol = volume(remote)
		await remoteVol.writeFile('/z.txt', enc.encode('old'))
		const baseReplica = localSyncReplica(remote, journaledChangeSource(remote), {
			lazyContent: false,
			localActorId: 'server'
		})
		let updateDuringScan = false
		const remoteReplica: SyncReplica = {
			...baseReplica,
			async pathScan(page, opts) {
				const result = await baseReplica.pathScan(page, opts)
				if (page === undefined && updateDuringScan) {
					updateDuringScan = false
					await remoteVol.writeFile('/z.txt', enc.encode('new'))
					await remote.caps!.content!.gcUnreferenced()
				}
				return result
			}
		}
		const local = memStorage()
		const vol1 = await synced({ local, remote: () => remoteReplica, interval: 99_999 })
		await vol1.writeFile('/marker', enc.encode('pushed'))
		await vol1.flush() // establish pushCursor so re-bootstrap reconciles absences
		vol1.destroy()

		for (let i = 0; i < PAGE; i++)
			await remoteVol.writeFile(`/a${String(i).padStart(3, '0')}`, enc.encode(String(i)))
		const localVol = volume(local)
		const state = JSON.parse(dec.decode(await localVol.readFile('/.state/sync'))) as {
			pullCursor?: string
		}
		delete state.pullCursor
		await localVol.writeFile('/.state/sync', enc.encode(JSON.stringify(state)))

		updateDuringScan = true
		const vol2 = track(await synced({ local, remote: () => remoteReplica, interval: 99_999 }))
		expect(dec.decode(await vol2.readFile('/z.txt'))).toBe('new')
		await vol2.flush()
		expect(dec.decode(await remoteVol.readFile('/z.txt'))).toBe('new')
	})

	// ── Dual-source wiring, client<->server factory (#144 item 7) ─────────────
	// Asserts synced() drives PULL with excludeOrigin=clientId and stamps PUSH
	// applies with source=REMOTE_SOURCE. excludeLocalSource (local deltas) is
	// covered at the unit level (journaledChangeSource) since the local replica is
	// internal to synced().
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

// ── Sync reset / generations ──────────────────────────────────────────────────
// A controllable fake SERVER replica: it reports a `generation` + advisory
// `resetId` on its handshake and echoes the generation on pull/scan pages, so the
// tests drive the handshake branch (equal / adopt / migrate / client-reset), the
// mid-session echo, and the take-mine republish + crash-resume (which ride the
// ordinary push under eventual consistency — no publishing lock).

function sha256Hex(data: Uint8Array): string {
	return createHash('sha256').update(data).digest('hex')
}

type LocalBackend = ReturnType<typeof memStorage>

interface FakeServer {
	replica: SyncReplica
	generation: number | undefined
	/** The volume's stable, unique lineage identity surfaced on the handshake. */
	lineageId: string | undefined
	/** The advisory "reset in progress" flag surfaced on the handshake. */
	resetId: string | undefined
	/** Override the generation echoed on pull pages (default: `generation`). */
	deltaGeneration: number | undefined
	/** How many times the client ran a full bootstrap (pathScan) against us. */
	scanCalls: number
	/** If set, the next push (applyPathChanges) throws it — simulates a fence 409. */
	pushError: Error | undefined
	/** If set, `reset` throws it — simulates a lost CAS / offline server. */
	resetError: Error | undefined
	/** Every push received (for take-mine republish tests). */
	pushes: Array<{ changes: PathChange[] }>
	seed(path: string, content: string): void
	/** Empty the tree + blobs — simulate the endpoint becoming a different, empty volume. */
	clear(): void
}

function fakeServer(
	init: { generation?: number; lineageId?: string; files?: Record<string, string> } = {}
): FakeServer {
	const blobs = new Map<string, Uint8Array>()
	const puts = new Map<string, PathChange>()
	const server: FakeServer = {
		generation: init.generation,
		lineageId: init.lineageId,
		resetId: undefined,
		deltaGeneration: undefined,
		scanCalls: 0,
		pushError: undefined,
		resetError: undefined,
		pushes: [],
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
		clear() {
			puts.clear()
			blobs.clear()
		},
		replica: {} as SyncReplica
	}
	for (const [p, content] of Object.entries(init.files ?? {})) server.seed(p, content)
	server.replica = {
		handshake: async () => ({
			generation: server.generation,
			resetId: server.resetId,
			lineageId: server.lineageId
		}),
		// The real CAS, in miniature: `adopt-mine` bumps the epoch and raises the
		// advisory flag; `complete` lowers it. (`fromGeneration` matching is the real
		// server's job — `resetError` stands in for a lost race.)
		reset: async (body) => {
			if (server.resetError) throw server.resetError
			if (body.mode === 'complete') {
				server.resetId = undefined
				return {}
			}
			server.generation = (server.generation ?? 0) + 1
			server.resetId = body.resetId
			return { generation: server.generation }
		},
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
		applyPathChanges: async (changes, _get) => {
			if (server.pushError) {
				const e = server.pushError
				server.pushError = undefined
				throw e
			}
			server.pushes.push({ changes })
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

async function readSyncState(local: LocalBackend): Promise<{
	generation?: number
	lineageId?: string
	pullCursor?: string
	pushCursor?: string
	pendingReset?: { resetId: string; fromGeneration: number; toGeneration?: number }
}> {
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

	it('does not send an empty push', async () => {
		const server = fakeServer({ generation: 5 })
		const local = memStorage()
		await seedSyncState(local, { generation: 5, pullCursor: '0', pushCursor: '0' })
		track(await synced({ local, remote: () => server.replica, interval: 99_999 }))

		expect(server.pushes).toEqual([])
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

	// A fenced push (409 generation_stale surfaced as GenerationStaleError) is
	// treated like a handshake mismatch: adopt the server's generation + reset.
	it('client-resets when a push is fenced with generation_stale', async () => {
		const server = fakeServer({ generation: 1 })
		server.pushError = new GenerationStaleError(2) // server bumped between handshake and push
		const local = memStorage()
		await volume(local).writeFile('/keep.txt', enc.encode('mine'))
		await seedSyncState(local, { generation: 1, pullCursor: '0', pushCursor: '0' })
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		expect(await vol.exists('/keep.txt')).toBe(false) // discarded on the fence
		const state = await readSyncState(local)
		expect(state.generation).toBe(2) // adopted the fenced generation
		expect(state.pullCursor).toBeUndefined() // cursors cleared → re-bootstrap next cycle
	})

	// takeTheirs(): discard unpushed local work + re-pull server.
	it('takeTheirs() discards local and re-pulls the server', async () => {
		const server = fakeServer({ generation: 3, files: { '/server.txt': 'theirs' } })
		const local = memStorage()
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		expect(await vol.exists('/server.txt')).toBe(true)
		await vol.writeFile('/mine.txt', enc.encode('unpushed work')) // never flushed
		await vol.takeTheirs()
		expect(await vol.exists('/mine.txt')).toBe(false) // discarded before any push
		expect(await vol.exists('/server.txt')).toBe(true) // re-pulled from the server
	})

	// A symlink in the swept tree must be unlinked, never descended into (a link to a
	// preserved dir would otherwise have its TARGET's contents deleted).
	it('takeTheirs() unlinks a symlink without descending into its target', async () => {
		const server = fakeServer({ generation: 3, files: { '/server.txt': 'theirs' } })
		const local = memStorage()
		const vol = track(
			await synced({
				local,
				remote: () => server.replica,
				interval: 99_999,
				ignore: (p) => p.startsWith('/state/cache/')
			})
		)
		await vol.mkdir('/state/cache', { recursive: true })
		await vol.writeFile('/state/cache/blob', enc.encode('MINE'))
		await vol.symlink('/state/cache', '/link-to-cache')
		await vol.takeTheirs()
		expect(await vol.exists('/link-to-cache')).toBe(false) // the link is gone
		expect(dec.decode(await vol.readFile('/state/cache/blob'))).toBe('MINE') // target intact
	})

	// A host's OWN ignores are host-private in the FULL sense: a reset must not discard
	// them either, or `ignore` would be a wire filter with a data-loss hole.
	it('takeTheirs() keeps a host ignore, not just the built-in root', async () => {
		const server = fakeServer({ generation: 3, files: { '/server.txt': 'theirs' } })
		const local = memStorage()
		const vol = track(
			await synced({
				local,
				remote: () => server.replica,
				interval: 99_999,
				ignore: (p) => p.startsWith('/state/cache/')
			})
		)
		await vol.mkdir('/state/cache', { recursive: true })
		await vol.writeFile('/state/cache/blob', enc.encode('MINE'))
		await vol.writeFile('/mine.md', enc.encode('mine'))
		await vol.takeTheirs()
		expect(dec.decode(await vol.readFile('/state/cache/blob'))).toBe('MINE')
		expect(await vol.exists('/mine.md')).toBe(false) // synced data still discarded
	})

	// A reset discards the SYNCED replica, not the credentials this host acquired.
	it('takeTheirs() keeps the host-private root', async () => {
		const server = fakeServer({ generation: 3, files: { '/server.txt': 'theirs' } })
		const local = memStorage()
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		await vol.mkdir('/host/accounts', { recursive: true })
		await vol.mkdir('/host/connections/chatgpt', { recursive: true })
		await vol.writeFile('/host/accounts/a.json', enc.encode('CRED'))
		await vol.writeFile('/host/connections/chatgpt/default.json', enc.encode('CONN'))
		await vol.writeFile('/mine.md', enc.encode('mine'))
		await vol.takeTheirs()
		expect(dec.decode(await vol.readFile('/host/accounts/a.json'))).toBe('CRED')
		expect(dec.decode(await vol.readFile('/host/connections/chatgpt/default.json'))).toBe('CONN')
		expect(await vol.exists('/mine.md')).toBe(false) // synced data still discarded
	})

	// takeMine(): CAS the server's lineage, then re-tag local as mine + rewind the
	// push cursor, so the ORDINARY push republishes the whole volume (pulled files
	// included). The drain then clears the server's advisory reset flag.
	it('take mine republishes the whole volume over ordinary push and signals completion', async () => {
		const server = fakeServer({ generation: 1, files: { '/server.txt': 'orig' } })
		const local = memStorage()
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		expect(await vol.exists('/server.txt')).toBe(true) // bootstrapped (tagged REMOTE_SOURCE)
		await vol.writeFile('/deleted.txt', enc.encode('temporary'))
		await vol.rm('/deleted.txt')
		await vol.writeFile('/mine.txt', enc.encode('local'))
		await vol.flush()
		server.pushes.length = 0 // ignore the pre-reset pushes

		await vol.takeMine() // CAS bumps the server 1 → 2 and raises its reset flag

		// The republish is the whole volume — both the pulled and the locally-authored
		// file (re-tagged as mine), NOT a delta that would drop the pulled one.
		const paths = server.pushes.flatMap((p) => p.changes.map((c) => c.path))
		expect(paths).toContain('/server.txt') // pulled file preserved via the re-tag
		expect(paths).toContain('/mine.txt')
		expect(paths).not.toContain('/deleted.txt') // empty target needs no tombstones
		expect(await vol.exists('/mine.txt')).toBe(true) // local kept intact
		expect((await readSyncState(local)).generation).toBe(2)
		expect(server.resetId).toBeUndefined() // drained → the server's flag was cleared
		expect((await readSyncState(local)).pendingReset).toBeUndefined() // cleared on completion
	})

	// The intent is persisted BEFORE the CAS, so a CAS that never lands must roll it
	// back — there is nothing to resume, and local must survive untouched.
	it('take mine rolls the intent back when the reset fails', async () => {
		const server = fakeServer({ generation: 1 })
		const local = memStorage()
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		await vol.writeFile('/mine.txt', enc.encode('local'))
		server.resetError = new Error('lost the CAS')

		await expect(vol.takeMine()).rejects.toThrow('lost the CAS')
		expect(await vol.exists('/mine.txt')).toBe(true) // untouched
		expect((await readSyncState(local)).pendingReset).toBeUndefined() // nothing to resume
		expect((await readSyncState(local)).generation).toBe(1) // lineage unchanged
	})

	// A peer with no lineage (P2P, or a legacy server): "take mine" has nothing to
	// CAS against, so it refuses rather than silently republishing.
	it('take mine refuses without a server generation', async () => {
		const server = fakeServer({ files: { '/server.txt': 'hi' } }) // generation undefined
		const local = memStorage()
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		await expect(vol.takeMine()).rejects.toThrow('take mine requires a server generation')
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

	// Crash mid-"take mine" persists `pendingReset`. On reboot, while our reset still
	// owns the server (resetId matches), finish local prep + republish over ordinary
	// sync — never discard the volume we meant to publish, despite the generation
	// mismatch.
	it('crash-resume: resumes the republish when our reset still owns the server', async () => {
		const server = fakeServer({ generation: 6 })
		server.resetId = 'mine-1'
		const local = memStorage()
		await volume(local).writeFile('/mine.txt', enc.encode('to publish'))
		// Crashed right after the CAS: pending has no toGeneration, generation still old.
		await seedSyncState(local, {
			generation: 5,
			pullCursor: '0',
			pushCursor: '0',
			pendingReset: { resetId: 'mine-1', fromGeneration: 5 }
		})
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		await vol.flush()
		expect(await vol.exists('/mine.txt')).toBe(true) // NOT discarded — resumed
		const pushed = server.pushes.flatMap((p) => p.changes.map((c) => c.path))
		expect(pushed).toContain('/mine.txt') // republished over ordinary push
		expect((await readSyncState(local)).generation).toBe(6) // prep adopted the new gen
		expect(server.scanCalls).toBe(0) // resumed, not a client-reset bootstrap
	})

	// Our republish already completed (resetId cleared, generation is the one our
	// reset produced): keep local, adopt, drop the intent.
	it('crash-resume: adopts + clears pending once our republish has completed', async () => {
		const server = fakeServer({ generation: 6 }) // resetId cleared (completed)
		const local = memStorage()
		await volume(local).writeFile('/mine.txt', enc.encode('published'))
		await seedSyncState(local, {
			generation: 6,
			pullCursor: '0',
			pushCursor: '0',
			pendingReset: { resetId: 'mine-1', fromGeneration: 5, toGeneration: 6 }
		})
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		await vol.flush()
		expect(await vol.exists('/mine.txt')).toBe(true) // kept — we authored this baseline
		const state = await readSyncState(local)
		expect(state.generation).toBe(6)
		expect(state.pendingReset).toBeUndefined() // intent dropped
		expect(server.scanCalls).toBe(0)
	})

	// A DIFFERENT reset won (a newer generation owned by another resetId): abandon our
	// intent and client-reset to the winner's baseline.
	it('crash-resume: a different reset won → abandon intent + client-reset to the winner', async () => {
		const server = fakeServer({ generation: 7, files: { '/winner.txt': 'won' } })
		server.resetId = 'someone-else'
		const local = memStorage()
		await volume(local).writeFile('/mine.txt', enc.encode('lost the race'))
		await seedSyncState(local, {
			generation: 6,
			pullCursor: '0',
			pushCursor: '0',
			pendingReset: { resetId: 'mine-1', fromGeneration: 5, toGeneration: 6 }
		})
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		await vol.flush()
		expect(await vol.exists('/mine.txt')).toBe(false) // discarded — winner's baseline wins
		expect(await vol.exists('/winner.txt')).toBe(true)
		const state = await readSyncState(local)
		expect(state.generation).toBe(7)
		expect(state.pendingReset).toBeUndefined()
	})

	// ── Lineage identity gate (issue #245) ─────────────────────────────────────
	// `generation` is only an epoch counter, seeded to 1 in EVERY volume, so two
	// genuinely different server volumes are indistinguishable by generation alone.
	// The stable, unique `lineageId` disambiguates them: a different one means the
	// stored cursors were minted against another volume → client-reset + re-bootstrap.

	// RED 1 — different lineage, same generation ⇒ reset. On main this diverges:
	// 1 === 1 ⇒ "same lineage" ⇒ cursors reused ⇒ /keep.txt survives, /theirs never lands.
	it('client-resets when the lineageId differs at the same generation', async () => {
		const server = fakeServer({ generation: 1, lineageId: 'B', files: { '/theirs.txt': 'x' } })
		const local = memStorage()
		await volume(local).writeFile('/keep.txt', enc.encode('mine'))
		await seedSyncState(local, {
			generation: 1,
			lineageId: 'A',
			pullCursor: '0',
			pushCursor: '0'
		})
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		expect(await vol.exists('/keep.txt')).toBe(false) // discarded — different volume
		expect(dec.decode(await vol.readFile('/theirs.txt'))).toBe('x') // re-bootstrapped from B
		expect((await readSyncState(local)).lineageId).toBe('B') // adopted the new lineage
		expect(server.scanCalls).toBeGreaterThanOrEqual(1)
	})

	// RED 2 — same lineage, same generation ⇒ no reset (regression guard).
	it('runs a normal sync when the lineageId and generation both match', async () => {
		const server = fakeServer({ generation: 5, lineageId: 'A' })
		const local = memStorage()
		await volume(local).writeFile('/keep.txt', enc.encode('mine'))
		await seedSyncState(local, {
			generation: 5,
			lineageId: 'A',
			pullCursor: '0',
			pushCursor: '0'
		})
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		expect(await vol.exists('/keep.txt')).toBe(true) // cursors preserved, no reset
		expect(server.scanCalls).toBe(0)
	})

	// RED 3 — same lineage, bumped generation ⇒ reset (existing behaviour preserved).
	it('still resets on a bumped generation within the same lineage', async () => {
		const server = fakeServer({ generation: 2, lineageId: 'A', files: { '/theirs.txt': 'x' } })
		const local = memStorage()
		await volume(local).writeFile('/keep.txt', enc.encode('mine'))
		await seedSyncState(local, {
			generation: 1,
			lineageId: 'A',
			pullCursor: '0',
			pushCursor: '0'
		})
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		expect(await vol.exists('/keep.txt')).toBe(false) // discarded — new epoch
		expect(dec.decode(await vol.readFile('/theirs.txt'))).toBe('x')
		const state = await readSyncState(local)
		expect(state.generation).toBe(2)
		expect(state.lineageId).toBe('A') // same volume, kept
	})

	// RED 4 — legacy/undefined lineage ⇒ unchanged (opted-out host behaves as today).
	it('ignores the identity gate when the server omits lineageId', async () => {
		const server = fakeServer({ generation: 5 }) // lineageId undefined
		const local = memStorage()
		await volume(local).writeFile('/keep.txt', enc.encode('mine'))
		await seedSyncState(local, {
			generation: 5,
			lineageId: 'A',
			pullCursor: '0',
			pushCursor: '0'
		})
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		expect(await vol.exists('/keep.txt')).toBe(true) // no reset — no lineage signal
		expect(server.scanCalls).toBe(0)
		expect((await readSyncState(local)).lineageId).toBe('A') // stored lineage untouched
	})

	// Codex P1 (feedback A): a replica that synced BEFORE lineageId existed keeps
	// cursors but no lineageId. Those cursors were minted against a volume we can't
	// identify, so they must not be reused (a different volume at the same generation
	// would skip its files). It re-bootstraps — but WITHOUT discarding local, since it
	// may still be the same volume with un-pushed offline edits.
	it('re-bootstraps a cursor-bearing legacy replica without discarding local edits', async () => {
		const server = fakeServer({ generation: 1, lineageId: 'B', files: { '/theirs.txt': 'x' } })
		const local = memStorage()
		await volume(local).writeFile('/offline.txt', enc.encode('un-pushed edit')) // past pushCursor
		await seedSyncState(local, { generation: 1, pullCursor: '5', pushCursor: '5' }) // no lineageId
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		expect(dec.decode(await vol.readFile('/theirs.txt'))).toBe('x') // full re-bootstrap saw B
		expect(await vol.exists('/offline.txt')).toBe(true) // local edit preserved (merged, not wiped)
		expect((await readSyncState(local)).lineageId).toBe('B') // identity now recorded
		expect(server.scanCalls).toBeGreaterThanOrEqual(1) // cursors not reused
	})

	// A genuinely fresh replica (no cursors) with a lineage-providing server adopts the
	// observed id and bootstraps once — no spurious extra reset before the bootstrap.
	it('adopts the lineageId on a fresh replica without a spurious reset', async () => {
		const server = fakeServer({ generation: 3, lineageId: 'C', files: { '/hi.txt': 'x' } })
		const local = memStorage()
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		expect(dec.decode(await vol.readFile('/hi.txt'))).toBe('x')
		const state = await readSyncState(local)
		expect(state.lineageId).toBe('C')
		expect(state.generation).toBe(3)
	})

	// Codex P1 (feedback B): crash mid "take mine" on volume A, then reconnect to a
	// DIFFERENT volume B. resumeAction classifies by generation, which is meaningless
	// across volumes; reusing A's cursors would skip B's files. The gate must abandon
	// the void intent and re-bootstrap KEEPING local (the user chose to publish it).
	it('re-bootstraps keeping local when a pending take-mine reconnects to a different volume', async () => {
		// server.resetId stays undefined — our reset 'mine-1' never touched volume B, and
		// B's generation coincidentally equals fromGeneration (fresh volumes share epoch 1).
		const server = fakeServer({ generation: 5, lineageId: 'B', files: { '/theirs.txt': 'x' } })
		const local = memStorage()
		await volume(local).writeFile('/mine.txt', enc.encode('to publish'))
		await seedSyncState(local, {
			generation: 5,
			lineageId: 'A', // we synced against a different volume before the crash
			pullCursor: '0',
			pushCursor: '0',
			pendingReset: { resetId: 'mine-1', fromGeneration: 5 }
		})
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		await vol.flush()
		expect(await vol.exists('/mine.txt')).toBe(true) // NOT discarded — local preserved
		expect(dec.decode(await vol.readFile('/theirs.txt'))).toBe('x') // merged with volume B
		const state = await readSyncState(local)
		expect(state.lineageId).toBe('B') // now tracking the volume we actually reached
		expect(state.pendingReset).toBeUndefined() // the void take-mine intent was cleared
	})

	// Codex round-3 P1: a previously-PULLED file (journal tagged REMOTE_SOURCE) that is
	// absent from the new volume's snapshot must not be stranded local-only. The legacy
	// re-bootstrap re-tags the retained tree as local (adoptAllAsLocal) so it is pushed.
	it('re-publishes previously-pulled files when a legacy replica re-bootstraps onto a new volume', async () => {
		// Legacy server (no generation/lineageId): client pulls /pulled.txt (REMOTE_SOURCE)
		// and records no lineageId.
		const server = fakeServer({ files: { '/pulled.txt': 'data' } })
		const local = memStorage()
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		expect(await vol.exists('/pulled.txt')).toBe(true)
		expect((await readSyncState(local)).lineageId).toBeUndefined() // legacy: no identity stored

		// The endpoint is now a DIFFERENT, empty volume that reports an identity.
		server.clear()
		server.generation = 1
		server.lineageId = 'B'
		server.pushes.length = 0

		await vol.flush() // legacy adoption → rebootstrapKeepingLocal (+ adoptAllAsLocal) → bootstrap
		await vol.flush() // drain the push of the re-tagged tree

		// /pulled.txt is NOT stranded: it is re-published to volume B (not filtered as REMOTE_SOURCE).
		const pushedPaths = server.pushes.flatMap((p) => p.changes.map((c) => c.path))
		expect(pushedPaths).toContain('/pulled.txt')
		expect(await vol.exists('/pulled.txt')).toBe(true)
		expect((await readSyncState(local)).lineageId).toBe('B')
	})

	it('publishes a retained local deletion after legacy re-bootstrap', async () => {
		const server = fakeServer({ files: { '/deleted.txt': 'remote copy' } })
		const local = memStorage()
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		await vol.rm('/deleted.txt')

		server.generation = 1
		server.lineageId = 'B'
		server.pushes.length = 0
		await vol.flush()
		await vol.flush()

		const pushed = server.pushes.flatMap((push) => push.changes)
		expect(pushed).toContainEqual(expect.objectContaining({ kind: 'delete', path: '/deleted.txt' }))
	})

	// Codex round-3 P1: a pending take-mine with NO stored lineageId (pre-feature) can't
	// be verified against the server's identity, so the generation-based resumeAction is
	// unsafe. Treat it as unverifiable → re-bootstrap keeping local.
	it('re-bootstraps a pending replica that has no stored lineageId (unverifiable)', async () => {
		// Server generation equals fromGeneration, so the old resumeAction would 'adopt' and
		// keep the (foreign) cursors, skipping the new volume's files.
		const server = fakeServer({ generation: 5, lineageId: 'B', files: { '/theirs.txt': 'x' } })
		const local = memStorage()
		await volume(local).writeFile('/mine.txt', enc.encode('to publish'))
		await seedSyncState(local, {
			generation: 5, // no lineageId ever recorded
			pullCursor: '0',
			pushCursor: '0',
			pendingReset: { resetId: 'mine-1', fromGeneration: 5 }
		})
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		await vol.flush()
		expect(await vol.exists('/mine.txt')).toBe(true) // local preserved
		expect(dec.decode(await vol.readFile('/theirs.txt'))).toBe('x') // re-bootstrapped from B
		const state = await readSyncState(local)
		expect(state.lineageId).toBe('B')
		expect(state.pendingReset).toBeUndefined()
	})

	// Codex round-3 P1: a GENERATION-fenced push while a take-mine is in flight must not
	// destructively reconcile (clientReset) — that would delete the snapshot the user chose
	// to publish. It defers to the handshake, which resolves the pending reset safely.
	it('does not discard local when a generation-fenced push races a pending take-mine', async () => {
		const server = fakeServer({ generation: 5 }) // lineageId undefined
		server.resetId = 'mine-1' // our reset owns the server → resume keeps the pending intent
		server.pushError = new GenerationStaleError(6) // the republish push is fenced
		const local = memStorage()
		await volume(local).writeFile('/mine.txt', enc.encode('to publish'))
		await seedSyncState(local, {
			generation: 5,
			pullCursor: '0',
			pushCursor: '0',
			pendingReset: { resetId: 'mine-1', fromGeneration: 5 }
		})
		const vol = track(await synced({ local, remote: () => server.replica, interval: 99_999 }))
		expect(await vol.exists('/mine.txt')).toBe(true) // NOT discarded on the fence — deferred
		expect((await readSyncState(local)).pendingReset).toBeDefined() // intent kept for the handshake
	})
})

// The fs-level change signal: a committed local write drives an immediate,
// coalesced push — no explicit flush() and without waiting for the poll interval.
// Sync becomes a Volume concern (any writer: user, app, agent) rather than the
// caller remembering to flush.
describe('synced (proactive push on local change)', () => {
	const destroyers: Array<() => void> = []
	afterEach(() => {
		for (const d of destroyers.splice(0)) d()
		vi.useRealTimers()
	})
	function track<T extends { destroy(): void }>(vol: T): T {
		destroyers.push(() => vol.destroy())
		return vol
	}

	it('pushes a local write without an explicit flush()', async () => {
		vi.useFakeTimers()
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await vol.writeFile('/proactive.txt', enc.encode('auto'))
		// No flush(): the fs-level change signal should schedule the push.
		await vi.advanceTimersByTimeAsync(3_000)
		expect(dec.decode(await volume(remote).readFile('/proactive.txt'))).toBe('auto')
	})
})

// The trigger must ignore the engine's own bookkeeping writes (cursor advances
// under /.state), or every push would schedule another push forever. After a
// change settles with no further user writes, the engine must go quiet.
describe('synced (proactive push does not self-loop)', () => {
	const destroyers: Array<() => void> = []
	afterEach(() => {
		for (const d of destroyers.splice(0)) d()
		vi.useRealTimers()
	})
	function track<T extends { destroy(): void }>(vol: T): T {
		destroyers.push(() => vol.destroy())
		return vol
	}

	it('goes quiet after a local write settles (no cursor-write feedback loop)', async () => {
		vi.useFakeTimers()
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		let syncing = 0
		vol.onStatusChange((s) => {
			if (s === 'syncing') syncing++
		})
		await vol.writeFile('/x.txt', enc.encode('1'))
		await vi.advanceTimersByTimeAsync(3_000) // the one proactive push
		const afterSettle = syncing
		expect(afterSettle).toBeGreaterThan(0)
		await vi.advanceTimersByTimeAsync(10_000) // no further writes → must stay quiet
		expect(syncing).toBe(afterSettle)
	})
})

// A device that only RECEIVES remote changes must not treat the pull-applied
// writes as local edits and bounce a push back — the trigger skips REMOTE_SOURCE.
describe('synced (proactive push ignores remote-applied pulls)', () => {
	const destroyers: Array<() => void> = []
	afterEach(() => {
		for (const d of destroyers.splice(0)) d()
		vi.useRealTimers()
	})
	function track<T extends { destroy(): void }>(vol: T): T {
		destroyers.push(() => vol.destroy())
		return vol
	}

	it('does not schedule a push when a pull applies remote changes', async () => {
		vi.useFakeTimers()
		const remote = memStorage()
		const a = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		const b = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		let bSyncing = 0
		b.onStatusChange((s) => {
			if (s === 'syncing') bSyncing++
		})
		await a.writeFile('/shared.txt', enc.encode('hi'))
		await vi.advanceTimersByTimeAsync(3_000) // a pushes proactively
		await b.flush() // b pulls /shared.txt (applied as REMOTE_SOURCE)
		expect(dec.decode(await b.readFile('/shared.txt'))).toBe('hi')
		const afterPull = bSyncing
		await vi.advanceTimersByTimeAsync(3_000) // the pull must NOT arm a push
		expect(bSyncing).toBe(afterPull)
	})
})

// Coalescing: a burst of local writes folds into a single push, not one per write
// (the whole point of doing this at the fs level with a debounce).
describe('synced (proactive push coalesces a burst)', () => {
	const destroyers: Array<() => void> = []
	afterEach(() => {
		for (const d of destroyers.splice(0)) d()
		vi.useRealTimers()
	})
	function track<T extends { destroy(): void }>(vol: T): T {
		destroyers.push(() => vol.destroy())
		return vol
	}

	it('pushes several rapid writes in one sync', async () => {
		vi.useFakeTimers()
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		let syncing = 0
		vol.onStatusChange((s) => {
			if (s === 'syncing') syncing++
		})
		await vol.writeFile('/a.txt', enc.encode('a'))
		await vol.writeFile('/b.txt', enc.encode('b'))
		await vol.writeFile('/c.txt', enc.encode('c'))
		await vi.advanceTimersByTimeAsync(3_000)
		expect(syncing).toBe(1)
		const rv = volume(remote)
		expect(dec.decode(await rv.readFile('/a.txt'))).toBe('a')
		expect(dec.decode(await rv.readFile('/b.txt'))).toBe('b')
		expect(dec.decode(await rv.readFile('/c.txt'))).toBe('c')
	})

	it('pushes three seconds after the latest write', async () => {
		vi.useFakeTimers()
		const vol = track(await synced({ local: memStorage(), remote: memStorage() }))
		let syncing = 0
		vol.onStatusChange((status) => {
			if (status === 'syncing') syncing++
		})

		await vol.writeFile('/a.txt', enc.encode('a'))
		await vi.advanceTimersByTimeAsync(2_000)
		await vol.writeFile('/b.txt', enc.encode('b'))
		await vi.advanceTimersByTimeAsync(2_999)
		expect(syncing).toBe(0)

		await vi.advanceTimersByTimeAsync(1)
		expect(syncing).toBe(1)
	})

	it('pushes after fifteen seconds of continuous writes', async () => {
		vi.useFakeTimers()
		const vol = track(await synced({ local: memStorage(), remote: memStorage(), interval: 99_999 }))
		let syncing = 0
		vol.onStatusChange((status) => {
			if (status === 'syncing') syncing++
		})

		await vol.writeFile('/state.json', enc.encode('0'))
		for (let n = 1; n <= 7; n++) {
			await vi.advanceTimersByTimeAsync(2_000)
			await vol.writeFile('/state.json', enc.encode(String(n)))
		}
		await vi.advanceTimersByTimeAsync(999)
		expect(syncing).toBe(0)

		await vi.advanceTimersByTimeAsync(1)
		expect(syncing).toBe(1)
	})

	it('does not sync again after an explicit flush', async () => {
		vi.useFakeTimers()
		const vol = track(await synced({ local: memStorage(), remote: memStorage(), interval: 99_999 }))
		let syncing = 0
		vol.onStatusChange((status) => {
			if (status === 'syncing') syncing++
		})

		await vol.writeFile('/state.json', enc.encode('changed'))
		await vol.flush()
		expect(syncing).toBe(1)

		await vi.advanceTimersByTimeAsync(3_000)
		expect(syncing).toBe(1)
	})

	it('does not sync again when the regular interval satisfies a pending push', async () => {
		vi.useFakeTimers()
		const vol = track(await synced({ local: memStorage(), remote: memStorage(), interval: 2_000 }))
		let syncing = 0
		vol.onStatusChange((status) => {
			if (status === 'syncing') syncing++
		})

		await vol.writeFile('/state.json', enc.encode('changed'))
		await vi.advanceTimersByTimeAsync(2_000)
		expect(syncing).toBe(1)

		await vi.advanceTimersByTimeAsync(1_000)
		expect(syncing).toBe(1)
	})

	it('does not sync again when resume satisfies a pending push', async () => {
		vi.useFakeTimers()
		const vol = track(await synced({ local: memStorage(), remote: memStorage(), interval: 99_999 }))
		let syncing = 0
		vol.onStatusChange((status) => {
			if (status === 'syncing') syncing++
		})

		await vol.writeFile('/state.json', enc.encode('changed'))
		vol.pause()
		vol.resume()
		await vi.advanceTimersByTimeAsync(0)
		expect(syncing).toBe(1)

		await vi.advanceTimersByTimeAsync(3_000)
		expect(syncing).toBe(1)
	})
})

// A single sync must fully converge, not one page per cycle: a coalesced poke
// fires once, so if a burst exceeds one page the receiver's pull has to drain
// every page in that cycle — otherwise the tail waits for the slow poll.
describe('synced (drains all delta pages in one cycle)', () => {
	const destroyers: Array<() => void> = []
	afterEach(() => {
		for (const d of destroyers.splice(0)) d()
	})
	function track<T extends { destroy(): void }>(vol: T): T {
		destroyers.push(() => vol.destroy())
		return vol
	}

	it('pulls more than one page of remote deltas in a single flush', async () => {
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		const rv = volume(remote)
		const n = PAGE + 5
		for (let i = 0; i < n; i++) await rv.writeFile(`/f${i}.txt`, enc.encode(String(i)))
		await vol.flush()
		expect(await vol.exists(`/f${n - 1}.txt`)).toBe(true)
	})
})

describe('synced (orphaned blob)', () => {
	const destroyers: Array<() => void> = []
	afterEach(() => {
		for (const destroy of destroyers.splice(0)) destroy()
	})

	it('pushes healthy changes past a local reference whose blob is missing', async () => {
		const local = memStorage()
		const localVolume = volume(local)
		await localVolume.writeFile('/healthy.txt', enc.encode('healthy'))
		await localVolume.writeFile('/orphan.txt', enc.encode('temporary'))
		const orphan = await localVolume.stat('/orphan.txt')
		await local.setMeta(orphan.ino, { contentHash: 'd'.repeat(64) }, { version: 99 })

		const remote = memStorage()
		const vol = await synced({ local, remote, interval: 99_999 })
		destroyers.push(() => vol.destroy())
		await vol.flush()

		const remoteVolume = volume(remote)
		expect(dec.decode(await remoteVolume.readFile('/healthy.txt'))).toBe('healthy')
		expect(await remoteVolume.exists('/orphan.txt')).toBe(false)
		expect(vol.status()).toBe('synced')
	})

	it('repairs a missing local blob when the remote already has it', async () => {
		const content = enc.encode('shared')
		const remote = memStorage()
		await volume(remote).writeFile('/seed.txt', content)

		const local = memStorage()
		const localVolume = volume(local)
		await localVolume.writeFile('/recovered.txt', enc.encode('temporary'))
		const recovered = await localVolume.stat('/recovered.txt')
		await local.setMeta(recovered.ino, { contentHash: sha256Hex(content) }, { version: 99 })

		const vol = await synced({ local, remote, interval: 99_999 })
		destroyers.push(() => vol.destroy())
		await vol.flush()

		expect(dec.decode(await vol.readFile('/recovered.txt'))).toBe('shared')
		expect(dec.decode(await volume(remote).readFile('/recovered.txt'))).toBe('shared')
		expect(vol.status()).toBe('synced')
	})
})
