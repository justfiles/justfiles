/**
 * Test infrastructure for path-based sync.
 *
 * Everything here is HARNESS — it must be correct and bug-free so a failing test
 * fails for a reason in the code under test, never from harness bugs. The code
 * under test is:
 *   - the `sync-wire` helpers (`syncMetaFromInode`, `changeDigest`, …),
 *   - the `sync-replica` adapters (`journaledChangeSource`, `localSyncReplica`),
 *   - the backend seams (`memStorage().caps.journal` / `.caps.pathApply`),
 *   - the `synced()` engine (push/pull/bootstrap/reconcile).
 *
 * `twoPeers()` builds two REAL local `SyncReplica`s over independent backends
 * (each mints its own inos). `syncBoth()`/`bootstrap()`/`pullFrom()` drive the
 * REAL replica methods directly (a flush-style pump with no timer), so the tests
 * exercise the engine, not the harness. Steady-state convergence relies on the
 * deterministic LWW that `applyPathChanges` performs on the target; adoption
 * (never-pushed keep-local) is engine state, so `adoptionPeers()` drives the real
 * `synced()` bootstrap.
 */

import { createHash } from 'node:crypto'
import type { Storage } from './storage'
import { memStorage } from './storage.mem'
import type { SyncReplica } from './sync-replica'
import { journaledChangeSource, localSyncReplica, PAGE } from './sync-replica'
import type { PathChange } from './sync-wire'
import { REMOTE_SOURCE, synced } from './synced'
import type { Ino, Stat } from './types'
import { FileType } from './types'
import type { Volume } from './volume'
import { volume } from './volume'

/**
 * Constructs a backend for the harness. `memStorage` is the default; the
 * conformance suite passes an `idbStorage`/`sqliteStorage` factory so the SAME
 * path-sync semantics run against every owned backend. Must be synchronous (both
 * mem and idb construct synchronously; sqlite migrates synchronously via
 * `node:sqlite`).
 */
export type BackendFactory = (opts?: { mintIno?: () => Ino; localActorId?: string }) => Storage

// ── Byte / hash helpers ───────────────────────────────────────────────────────

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const bytes = (s: string): Uint8Array => encoder.encode(s)
export const text = (b: Uint8Array): string => decoder.decode(b)

/** Lowercase hex SHA-256 — matches the production `sha256Hex` (crypto.subtle). */
export function sha256(data: Uint8Array | string): string {
	const buf = typeof data === 'string' ? encoder.encode(data) : data
	return createHash('sha256').update(buf).digest('hex')
}

// ── Ino minters (heterogeneous ino spaces) ────────────────────────────────────

let numericCounter = 2
/** Real-OS-style monotonically increasing numeric inos: "2", "3", … */
export const numericIno = (): Ino => String(numericCounter++)
/** UUID inos (browser/DO style). */
export const uuidIno = (): Ino => crypto.randomUUID()

// ── Staging options for the `write`/`mkdir` seam ──────────────────────────────

export type StageOpts = {
	/** Pin the path's version (test-only seam over the backend `path_version`). */
	version?: number
	mtimeNs?: string | number | bigint
	mode?: number
	/** Origin client-id stamped on the staged change (see `PathChange.source`). */
	source?: string
}

// ── Tracked backend (for orphan counting) ─────────────────────────────────────

/**
 * Wrap a `memStorage` and track every inode that gets metadata, so a test can
 * assert there are zero orphaned inodes (an ino minted but unreachable from the
 * tree — the classic ino-fork failure this design fixes).
 */
function trackedStorage(
	makeBackend: BackendFactory,
	opts?: { mintIno?: () => Ino; localActorId?: string }
): {
	storage: Storage
	orphanCount: () => Promise<number>
} {
	const base = makeBackend(opts)
	const live = new Set<Ino>([base.rootIno])
	const baseCaps = base.caps
	const atomicCreate = baseCaps?.atomicCreate

	const storage = {
		...base,
		caps: {
			...baseCaps,
			...(atomicCreate
				? {
						atomicCreate: async (
							dirIno: Ino,
							name: string,
							meta: Parameters<typeof atomicCreate>[2],
							options?: Parameters<typeof atomicCreate>[3]
						) => {
							const ino = await atomicCreate(dirIno, name, meta, options)
							live.add(ino)
							return ino
						}
					}
				: {})
		},
		async setMeta(
			ino: Ino,
			patch: Parameters<typeof base.setMeta>[1],
			options?: Parameters<typeof base.setMeta>[2]
		) {
			await base.setMeta(ino, patch, options)
			if (await base.getMeta(ino)) live.add(ino)
		},
		async deleteInode(ino: Ino) {
			await base.deleteInode(ino)
			if (!(await base.getMeta(ino))) live.delete(ino)
		}
	}

	async function orphanCount(): Promise<number> {
		const reachable = new Set<Ino>([base.rootIno])
		async function walk(dir: Ino): Promise<void> {
			let cursor = ''
			do {
				const { entries, next } = await base.listDirents(dir, cursor)
				for (const e of entries) {
					reachable.add(e.ino)
					if (e.type === FileType.Directory) await walk(e.ino)
				}
				cursor = next
			} while (cursor !== '')
		}
		await walk(base.rootIno)
		let n = 0
		for (const ino of live) {
			if (reachable.has(ino)) continue
			if (await base.getMeta(ino)) n++
		}
		return n
	}

	return { storage, orphanCount }
}

// ── Peer ──────────────────────────────────────────────────────────────────────

/** A single sync participant: a volume + its `SyncReplica` + staging sugar. */
export interface Peer {
	readonly id: string
	readonly replica: SyncReplica
	/** Set by the harness so a lazy peer can hydrate blobs from its remote. */
	remoteReplica?: SyncReplica

	// volume passthrough
	writeFile(path: string, data: Uint8Array): Promise<void>
	readFile(path: string): Promise<Uint8Array>
	readdir(path: string): ReturnType<Volume['readdir']>
	stat(path: string): Promise<Stat>
	exists(path: string): Promise<boolean>
	rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>
	rename(oldPath: string, newPath: string): Promise<void>
	mkdir(path: string, opts?: StageOpts & { recursive?: boolean }): Promise<void>
	symlink(target: string, path: string): Promise<void>
	lstat(path: string): Promise<Stat>
	readlink(path: string): Promise<string>

	// staging seam: create a regular file with a pinned version/meta
	write(path: string, data: Uint8Array, opts?: StageOpts): Promise<void>

	// content-hash presence
	hasLocalBlob(hash: string): Promise<boolean>

	// count inodes minted but unreachable from the tree (property test)
	orphanCount(): Promise<number>

	// harness pull-from-cursor; assigned by twoPeers
	pullFrom?(cursor: string): Promise<void>
}

function parentDir(path: string): string {
	const i = path.lastIndexOf('/')
	return i <= 0 ? '/' : path.slice(0, i)
}

function makePeer(
	storage: ReturnType<typeof memStorage>,
	orphanCount: () => Promise<number>,
	opts: { id: string; lazyContent?: boolean }
): Peer {
	const vol = volume(storage)
	const replica = localSyncReplica(storage, journaledChangeSource(storage), {
		lazyContent: opts.lazyContent ?? false,
		localActorId: opts.id
	})

	const peer: Peer = {
		id: opts.id,
		replica,
		writeFile: async (path, data) => {
			const dir = parentDir(path)
			if (dir !== '/') await vol.mkdir(dir, { recursive: true })
			await vol.writeFile(path, data)
		},
		readdir: (path) => vol.readdir(path),
		stat: (path) => vol.stat(path),
		exists: (path) => vol.exists(path),
		rm: (path, o) => vol.rm(path, o),
		rename: (a, b) => vol.rename(a, b),
		symlink: (target, path) => vol.symlink(target, path),
		lstat: (path) => vol.lstat(path),
		readlink: (path) => vol.readlink(path),
		orphanCount,
		hasLocalBlob: (hash) => replica.hasBlobByHash(hash),

		async readFile(path) {
			if (!opts.lazyContent) return vol.readFile(path)
			// Lazy hydration mirrors synced()'s wrapped readFile: a stub retains the
			// desired hash but no local blob; first read fetches by hash.
			const st = await vol.stat(path)
			if (st.type !== FileType.Regular || st.size === 0n || !st.contentHash)
				return vol.readFile(path)
			if (await replica.hasBlobByHash(st.contentHash)) return vol.readFile(path)
			const remote = peer.remoteReplica
			if (!remote) return vol.readFile(path)
			const data = await remote.getBlobByHash(st.contentHash)
			await replica.putBlobByHash(st.contentHash, data)
			return data
		},

		async mkdir(path, o) {
			await vol.mkdir(path, { recursive: o?.recursive, mode: o?.mode })
			await applyStageMeta(path, o)
		},

		async write(path, data, o) {
			const dir = parentDir(path)
			if (dir !== '/') await vol.mkdir(dir, { recursive: true })
			await vol.writeFile(path, data)
			await applyStageMeta(path, { ...o, contentHash: sha256(data) })
		}
	}

	// Stage meta directly on the backend, journaling a put. A pinned `version` is
	// threaded to setMeta -> journalPut (see MutationOptions.version), so a staged
	// write ships that EXACT version and sets the backend path_version to match —
	// which is what LWW compares on both replicas.
	async function applyStageMeta(
		path: string,
		o?: StageOpts & { contentHash?: string }
	): Promise<void> {
		if (!o) return
		const st = await vol.stat(path)
		const patch: Parameters<typeof storage.setMeta>[1] = {}
		if (o.mtimeNs !== undefined) patch.mtimeNs = BigInt(o.mtimeNs.toString())
		if (o.mode !== undefined) patch.mode = o.mode
		if (o.contentHash !== undefined) patch.contentHash = o.contentHash
		if (Object.keys(patch).length === 0 && o.version === undefined && o.source === undefined) return
		await storage.setMeta(st.ino, patch, { version: o.version, source: o.source })
	}

	return peer
}

// ── twoPeers / wire ───────────────────────────────────────────────────────────

export interface TwoPeers {
	client: Peer
	server: Peer
	/** Drive push+pull both directions to quiescence (timer disabled). */
	syncBoth(opts?: { limit?: number }): Promise<void>
	/** Page a full snapshot from server->client; returns the frozen high-water. */
	bootstrap(opts?: {
		limit?: number
		/** Called after each page is applied (lets a test mutate the remote mid-snapshot). */
		onPage?: (page: { syncCursor: string; done: boolean }) => Promise<void>
	}): Promise<{ syncCursor: string; pageCursors: string[] }>
	/** Every change that crossed the client->server push direction. */
	pushedChanges(): PathChange[]
}

/** Wire two backends into a bidirectional pump. */
export function wire(
	clientStorage: ReturnType<typeof memStorage>,
	serverStorage: ReturnType<typeof memStorage>,
	opts?: {
		lazyContent?: boolean
		clientOrphans?: () => Promise<number>
		serverOrphans?: () => Promise<number>
	}
): TwoPeers {
	const zero = async () => 0
	const client = makePeer(clientStorage, opts?.clientOrphans ?? zero, {
		id: 'client',
		lazyContent: opts?.lazyContent
	})
	const server = makePeer(serverStorage, opts?.serverOrphans ?? zero, { id: 'server' })
	client.remoteReplica = server.replica
	server.remoteReplica = client.replica

	const cursors = { c2s: '', s2c: '' }
	const pushedC2S: PathChange[] = []

	async function drain(
		source: Peer,
		target: Peer,
		key: 'c2s' | 's2c',
		limit: number,
		record: boolean
	): Promise<boolean> {
		let cursor = cursors[key]
		let done = false
		let any = false
		while (!done) {
			const res = await source.replica.pathDeltas(cursor, {
				excludeLocalSource: REMOTE_SOURCE,
				limit
			})
			if (res.changes.length > 0) {
				any = true
				if (record) pushedC2S.push(...res.changes)
			}
			// No pre-upload: like synced()'s pull, applyPathChanges owns content — an
			// eager target fetches each winner's blob via the callback, a lazy target
			// skips and hydrates on first read.
			await target.replica.applyPathChanges(res.changes, (h) => source.replica.getBlobByHash(h), {
				source: REMOTE_SOURCE
			})
			cursor = res.to
			done = res.done
		}
		cursors[key] = cursor
		return any
	}

	async function syncBoth(o?: { limit?: number }): Promise<void> {
		const limit = o?.limit ?? PAGE
		for (let pass = 0; pass < 20; pass++) {
			const a = await drain(client, server, 'c2s', limit, true)
			const b = await drain(server, client, 's2c', limit, false)
			if (!a && !b) return
		}
	}

	async function bootstrap(o?: {
		limit?: number
		onPage?: (page: { syncCursor: string; done: boolean }) => Promise<void>
	}): Promise<{ syncCursor: string; pageCursors: string[] }> {
		const limit = o?.limit ?? PAGE
		let page: string | undefined
		let syncCursor = ''
		const pageCursors: string[] = []
		do {
			const res = await server.replica.pathScan(page, { limit })
			syncCursor = res.syncCursor
			pageCursors.push(res.syncCursor)
			await client.replica.applyPathChanges(res.changes, (h) => server.replica.getBlobByHash(h), {
				source: REMOTE_SOURCE
			})
			if (o?.onPage) await o.onPage({ syncCursor: res.syncCursor, done: res.done })
			page = res.done ? undefined : res.next
		} while (page)
		return { syncCursor, pageCursors }
	}

	client.pullFrom = async (cursor: string): Promise<void> => {
		let c = cursor
		let done = false
		while (!done) {
			const res = await server.replica.pathDeltas(c, { excludeOrigin: client.id, limit: PAGE })
			await client.replica.applyPathChanges(res.changes, (h) => server.replica.getBlobByHash(h), {
				source: REMOTE_SOURCE
			})
			c = res.to
			done = res.done
		}
	}

	return { client, server, syncBoth, bootstrap, pushedChanges: () => pushedC2S }
}

/** Two fresh backends (UUID inos) wired bidirectionally. */
export function twoPeers(opts?: { lazyContent?: boolean; makeBackend?: BackendFactory }): TwoPeers {
	const make = opts?.makeBackend ?? memStorage
	const c = trackedStorage(make)
	const s = trackedStorage(make)
	return wire(c.storage, s.storage, {
		lazyContent: opts?.lazyContent,
		clientOrphans: c.orphanCount,
		serverOrphans: s.orphanCount
	})
}

// ── adoptionPeers (drives the real synced() bootstrap) ────────────────────────

export interface AdoptionPeers {
	local: Peer
	remote: Peer
	/** First sync: local adopts a non-empty remote (keep-local policy). */
	bootstrapLocalFromRemote(): Promise<void>
	/** Push local work up and pull remote down. */
	syncBoth(): Promise<void>
	destroy(): void
}

/**
 * A never-pushed local profile adopting a non-empty remote. `local` runs the
 * REAL `synced()` engine against `remote`'s backend, so the adoption same-path
 * policy (keep local, version it to win) is exercised, not re-implemented.
 */
export function adoptionPeers(): AdoptionPeers {
	const localT = trackedStorage(memStorage)
	const remoteT = trackedStorage(memStorage)
	// `remote` is the shared backend (the star-topology server).
	const remote = makePeer(remoteT.storage, remoteT.orphanCount, { id: 'remote' })
	let syncedVol: Awaited<ReturnType<typeof synced>> | null = null

	// Pre-bootstrap, `local` reads/writes its own backend; after bootstrap it
	// reads the same backend that synced() writes to, so it observes the merge.
	const local = makePeer(localT.storage, localT.orphanCount, { id: 'local' })

	return {
		local,
		remote,
		async bootstrapLocalFromRemote() {
			syncedVol = await synced({
				local: localT.storage,
				remote: remoteT.storage,
				interval: 99_999
			})
		},
		async syncBoth() {
			if (!syncedVol) throw new Error('call bootstrapLocalFromRemote first')
			await syncedVol.flush()
		},
		destroy() {
			syncedVol?.destroy()
		}
	}
}

/** Free-function orphan probe used by the path-sync tests. */
export function orphanCount(peer: Peer): Promise<number> {
	return peer.orphanCount()
}

// ── Deterministic op generator (property test) ────────────────────────────────

/** mulberry32 seeded PRNG. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const GEN_DIRS = ['/a', '/b', '/a/x', '/b/y'] as const
const GEN_FILES = ['/a/f', '/a/g', '/a/x/h', '/b/y/i', '/c'] as const

/** Apply one random mutation to a peer, tolerating benign races (ENOENT/EEXIST). */
export async function randomOp(rng: () => number, peer: Peer): Promise<void> {
	const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)] as T
	const roll = rng()
	try {
		if (roll < 0.45) {
			const file = pick(GEN_FILES)
			const dir = parentDir(file)
			if (dir !== '/') await peer.mkdir(dir, { recursive: true })
			await peer.writeFile(file, bytes(`v${Math.floor(rng() * 1000)}`))
		} else if (roll < 0.65) {
			await peer.rm(pick(GEN_FILES), { force: true, recursive: true })
		} else if (roll < 0.85) {
			await peer.mkdir(pick(GEN_DIRS), { recursive: true })
		} else {
			const from = pick(GEN_FILES)
			const to = pick(GEN_FILES)
			if (from !== to && (await peer.exists(from))) await peer.rename(from, to)
		}
	} catch (e) {
		const msg = (e as Error).message
		if (
			!msg.startsWith('ENOENT') &&
			!msg.startsWith('EEXIST') &&
			!msg.startsWith('ENOTDIR') &&
			!msg.startsWith('EISDIR') &&
			!msg.startsWith('ENOTEMPTY')
		)
			throw e
	}
}

/** Snapshot a peer's tree as a path->content map for byte-identity assertions. */
export async function treeSnapshot(peer: Peer): Promise<Record<string, string>> {
	const out: Record<string, string> = {}
	async function walk(path: string): Promise<void> {
		const entries = await peer.readdir(path)
		for (const e of entries) {
			if (e.name === '.state') continue // local-only
			const child = path === '/' ? `/${e.name}` : `${path}/${e.name}`
			if (e.type === FileType.Directory) {
				out[child] = '<dir>'
				await walk(child)
			} else {
				out[child] = text(await peer.readFile(child))
			}
		}
	}
	await walk('/')
	return out
}

// ── Backend conformance suite ─────────────────────────────────────────────────
// The same path-sync semantics, run against EVERY owned backend (mem, IDB,
// SQLite/DO) so the SHIPPING backends — not just this memStorage-based harness —
// are proven against identical specs. Cases are plain data (`{ name, run(makeBackend) }`),
// registered by two separate vitest files: packages/fs/sync-conformance.test.ts
// (mem + idb) and packages/core/src/storage.sqlite.conformance.test.ts (sqlite via
// node:sqlite). They live here in the harness — not a prod-looking module, and not
// a `*.test.ts` — because both test files import them, and a test file that also
// registers its own `describe`/`test` can't be cleanly imported by another.
//
// A case throws on failure. A backend that has not implemented the path-sync seams
// (`caps.journal` / `caps.pathApply` / `caps.content` + local-mutation journaling)
// fails these for the right reason (`not implemented`), and passes them once it
// lands the seams.

function assertEq<T>(actual: T, expected: T, msg: string): void {
	if (actual !== expected)
		throw new Error(`conformance: ${msg} — expected ${String(expected)}, got ${String(actual)}`)
}

export interface ConformanceCase {
	name: string
	run(makeBackend: BackendFactory): Promise<void>
}

/** The shared cases. Each exercises the core seams (journal deltas, apply, blobs). */
export const pathSyncConformanceCases: ConformanceCase[] = [
	{
		name: 'converges a create by path (delta + apply + blob-by-hash)',
		run: async (makeBackend) => {
			const { client, server, syncBoth } = twoPeers({ makeBackend })
			await server.writeFile('/data/note.txt', bytes('hello'))
			await syncBoth()
			assertEq(text(await client.readFile('/data/note.txt')), 'hello', 'create did not converge')
		}
	},
	{
		name: 'propagates a delete across a divergent tree',
		run: async (makeBackend) => {
			const { client, server, syncBoth } = twoPeers({ makeBackend })
			await server.writeFile('/app/x/f', bytes('S'))
			await client.writeFile('/app/x/f', bytes('C'))
			await syncBoth()
			await server.rm('/app/x', { recursive: true })
			await syncBoth()
			assertEq(await client.exists('/app/x'), false, 'delete did not propagate')
		}
	},
	{
		name: 'converges an in-place update with zero orphaned inodes',
		run: async (makeBackend) => {
			const { client, server, syncBoth } = twoPeers({ makeBackend })
			await server.writeFile('/a/f', bytes('v1'))
			await syncBoth()
			await server.writeFile('/a/f', bytes('v2'))
			await syncBoth()
			assertEq(text(await client.readFile('/a/f')), 'v2', 'update did not converge')
			assertEq(await client.orphanCount(), 0, 'orphaned inodes after in-place update')
		}
	},
	{
		name: 'moves a directory subtree on rename',
		run: async (makeBackend) => {
			const { client, server, syncBoth } = twoPeers({ makeBackend })
			await server.writeFile('/old/a', bytes('1'))
			await server.writeFile('/old/b', bytes('2'))
			await syncBoth()
			await server.rename('/old', '/new')
			await syncBoth()
			assertEq(await client.exists('/old'), false, 'old dir survived rename')
			assertEq(text(await client.readFile('/new/a')), '1', 'moved child /new/a missing')
			assertEq(text(await client.readFile('/new/b')), '2', 'moved child /new/b missing')
		}
	},
	{
		name: 'syncs a symlink by target',
		run: async (makeBackend) => {
			const { client, server, syncBoth } = twoPeers({ makeBackend })
			await server.writeFile('/target.txt', bytes('data'))
			await server.symlink('/target.txt', '/link')
			await syncBoth()
			assertEq((await client.lstat('/link')).type, FileType.Symlink, '/link is not a symlink')
			assertEq(await client.readlink('/link'), '/target.txt', 'symlink target wrong')
		}
	},
	{
		name: 'converges an empty regular file (zero-byte content)',
		run: async (makeBackend) => {
			// Diagnostic for the buildPutChange self-skip (ROADMAP item 3): a fresh
			// regular file journals nothing until its content write. writeFile always
			// ends in putBlob (empty content hashes to sha256('')), so an empty file
			// MUST still converge — proving the self-skip is benign via the public VFS.
			const { client, server, syncBoth } = twoPeers({ makeBackend })
			await server.writeFile('/empty.txt', bytes(''))
			await syncBoth()
			assertEq(await client.exists('/empty.txt'), true, 'empty file did not converge')
			assertEq(
				(await client.stat('/empty.txt')).type,
				FileType.Regular,
				'empty file is not a regular file'
			)
			assertEq(text(await client.readFile('/empty.txt')), '', 'empty file content wrong')
		}
	},
	{
		name: 'gcUnreferenced reclaims orphaned blobs, keeps referenced ones',
		run: async (makeBackend) => {
			const s = makeBackend()
			const content = s.caps?.content
			if (!content?.gcUnreferenced) throw new Error('conformance: backend exposes no content GC')
			const vol = volume(s)
			await vol.writeFile('/keep.txt', bytes('keep'))
			const keepHash = (await vol.stat('/keep.txt')).contentHash
			if (!keepHash) throw new Error('conformance: written file has no contentHash')
			// An orphan: bytes no inode references (never written through the tree).
			const orphanHash = sha256('orphan-bytes')
			await content.putByHash(orphanHash, bytes('orphan-bytes'))
			assertEq(await content.hasByHash(orphanHash), true, 'orphan blob not stored')
			const reclaimed = await content.gcUnreferenced()
			assertEq(reclaimed >= 1, true, 'gc reclaimed no orphan')
			assertEq(await content.hasByHash(orphanHash), false, 'orphan blob not reclaimed')
			assertEq(await content.hasByHash(keepHash), true, 'referenced blob wrongly reclaimed')
			assertEq(
				text((await content.getByHash(keepHash)) ?? new Uint8Array()),
				'keep',
				'kept blob corrupted'
			)
		}
	}
]
