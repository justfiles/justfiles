// Unit tests for the SQLite backend's path-sync capability seams that don't need
// the full journal/apply stack yet: the hash-addressed `caps.content` blob store
// and the `caps.subscribe` change feed. Both run under vitest via node's built-in
// node:sqlite (no bun); see storage.sqlite.conformance.test.ts for the DbAdapter
// shim rationale.

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { volume } from '@justfiles/fs'
import type { StorageChange } from '@justfiles/fs/storage'
import { FileType } from '@justfiles/fs/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSqliteAdapter } from './db.sqlite'
import { storage as sqliteStorage } from './storage.sqlite'

// Apply every migration in order (0001, 0002, …) exactly as the DO does via
// coreMigrations — so path-sync tables are present in the test DB too.
const migrationsDir = new URL('./migrations/', import.meta.url)
const schema = readdirSync(migrationsDir)
	.filter((f) => f.endsWith('.sql'))
	.sort()
	.map((f) => readFileSync(new URL(f, migrationsDir), 'utf8'))
	.join('\n')

function makeSqlite() {
	const db = new DatabaseSync(':memory:')
	db.exec(schema)
	const db64 = {
		prepare(sql: string) {
			const stmt = db.prepare(sql)
			stmt.setReadBigInts(true)
			return stmt
		},
		exec: (sql: string) => db.exec(sql)
	}
	return sqliteStorage(
		createSqliteAdapter(db64 as unknown as Parameters<typeof createSqliteAdapter>[0])
	)
}

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe('sqlite caps.content (hash-addressed blob store)', () => {
	let content: NonNullable<ReturnType<typeof sqliteStorage>['caps']>['content']
	beforeEach(() => {
		content = makeSqlite().caps?.content
	})

	it('exposes the content cap', () => {
		expect(content).toBeDefined()
	})

	it('round-trips a blob by hash', async () => {
		const hash = 'a'.repeat(64)
		await content!.putByHash(hash, bytes('hello world'))
		expect(text((await content!.getByHash(hash))!)).toBe('hello world')
	})

	it('reports presence by hash', async () => {
		const hash = 'b'.repeat(64)
		expect(await content!.hasByHash(hash)).toBe(false)
		await content!.putByHash(hash, bytes('data'))
		expect(await content!.hasByHash(hash)).toBe(true)
	})

	it('returns null for an absent hash', async () => {
		expect(await content!.getByHash('c'.repeat(64))).toBeNull()
	})

	it('is idempotent — re-putting the same hash keeps the content', async () => {
		const hash = 'd'.repeat(64)
		await content!.putByHash(hash, bytes('once'))
		await content!.putByHash(hash, bytes('once'))
		expect(text((await content!.getByHash(hash))!)).toBe('once')
	})
})

describe('sqlite caps.subscribe (change feed)', () => {
	const reg = (type: FileType) => ({
		type,
		size: 0n,
		mode: type === FileType.Directory ? 0o755 : 0o644,
		mtimeNs: 0n,
		ctimeNs: 0n
	})

	it('emits committed mutations so a volume can invalidate its cache', async () => {
		const s = makeSqlite()
		const changes: StorageChange[] = []
		const unsub = s.caps!.subscribe!((c) => changes.push(c))

		const ino = await s.caps!.atomicCreate!(s.rootIno, 'f', reg(FileType.Regular))
		await s.putBlob(ino, bytes('hi'))
		await s.setMeta(ino, { mode: 0o600 })
		await s.deleteDirent(s.rootIno, 'f')

		// atomicCreate emits meta + dirent; putBlob emits content; setMeta emits
		// meta; deleteDirent emits dirent.
		expect(changes.some((c) => c.kind === 'meta' && c.ino === ino)).toBe(true)
		expect(changes.some((c) => c.kind === 'content' && c.ino === ino)).toBe(true)
		expect(changes.some((c) => c.kind === 'dirent' && c.name === 'f')).toBe(true)

		const after = changes.length
		unsub()
		await s.setMeta(ino, { mode: 0o644 })
		expect(changes.length).toBe(after) // unsubscribe stops delivery
	})

	it('emits both dirents on a rename via atomicMove', async () => {
		const s = makeSqlite()
		const dir = await s.caps!.atomicCreate!(s.rootIno, 'd', reg(FileType.Directory))
		const file = await s.caps!.atomicCreate!(dir, 'a', reg(FileType.Regular))
		const changes: StorageChange[] = []
		s.caps!.subscribe!((c) => changes.push(c))

		await s.caps!.atomicMove!(dir, 'a', dir, 'b')

		const dirents = changes.filter((c) => c.kind === 'dirent' && c.ino === file)
		expect(dirents.map((c) => c.name).sort()).toEqual(['a', 'b'])
	})

	// The reason step 2 exists: a volume over sqlite must invalidate its cache when
	// Storage is mutated OUTSIDE the volume (as the sync layer's applyJournaled will
	// do on pull). volume() auto-subscribes to caps.subscribe; without emit() a stale
	// dirent would survive an external unlink (the 1edbd53d bug).
	it('a volume over sqlite sees an external delete via the change feed', async () => {
		const s = makeSqlite()
		const vol = volume(s)
		await vol.writeFile('/f', bytes('x'))
		expect(await vol.exists('/f')).toBe(true) // caches the dirent
		await s.deleteDirent(s.rootIno, 'f') // external unlink, bypassing the volume
		expect(await vol.exists('/f')).toBe(false) // feed invalidated the stale dirent
	})
})

// `atomicMove({ noReplace })` — the server's side of `rename(..., { exclusive: true })`.
// The refusal belongs INSIDE the transaction that rebinds the entry, so it is decided on
// the same read the move already does and cannot be overtaken by a write of this backend's
// own (#330).
//
// How much that buys against CONCURRENT clients is the adapter's business, not this
// guard's, and the two shipped adapters answer differently: the DO runs one event at a time
// with no manual BEGIN (see `createDOSqliteAdapter`), while `createSqliteAdapter` issues
// BEGIN per transaction without serialising entry — so two overlapping transactions there
// fail with "cannot start a transaction within a transaction" whatever they were doing (two
// plain renames included: it long predates this flag, and is filed on its own). So what is
// asserted here is what the guard itself promises — a taken name is refused, before any
// write happens — and the N-racer property is pinned where the store really decides it:
// `exclusive.test.ts` for mem/IDB, `fs.rename.test.ts` for clients over the wire.
describe('sqlite caps.atomicMove({ noReplace })', () => {
	it('refuses a taken destination and leaves both entries intact', async () => {
		const s = makeSqlite()
		const vol = volume(s)
		await vol.mkdir('/Inbox')
		await vol.writeFile('/Inbox/Kyoto.md', bytes('mine'))
		await vol.writeFile('/Kyoto.md', bytes('theirs'))
		await expect(vol.rename('/Inbox/Kyoto.md', '/Kyoto.md', { exclusive: true })).rejects.toThrow(
			/^EEXIST/
		)
		expect(text(await vol.readFile('/Kyoto.md'))).toBe('theirs')
		expect(text(await vol.readFile('/Inbox/Kyoto.md'))).toBe('mine')
		// A free destination still moves, and moving a name onto itself is not "taken".
		await vol.rename('/Inbox/Kyoto.md', '/Osaka.md', { exclusive: true })
		await vol.rename('/Osaka.md', '/Osaka.md', { exclusive: true })
		expect(text(await vol.readFile('/Osaka.md'))).toBe('mine')
	})

	it('throws before it writes — no dirent moved, no journal row, no blob orphaned', async () => {
		// The guard sits ahead of every mutation in the transaction, which is what makes the
		// refusal free: a loser leaves the tree byte-for-byte as it was, so `claimPath` can
		// number up and try again without anything to clean up.
		const s = makeSqlite()
		const vol = volume(s)
		await vol.writeFile('/one.md', bytes('one'))
		await vol.writeFile('/taken.md', bytes('taken'))
		const before = (await vol.readdir('/')).map((e) => e.name).sort()
		await expect(vol.rename('/one.md', '/taken.md', { exclusive: true })).rejects.toThrow(/^EEXIST/)
		expect((await vol.readdir('/')).map((e) => e.name).sort()).toEqual(before)
		expect(text(await vol.readFile('/one.md'))).toBe('one')
		expect(text(await vol.readFile('/taken.md'))).toBe('taken')
		// Nothing was staged and abandoned on the way in, either.
		expect(await s.caps!.content!.gcUnreferenced!()).toBe(0)
	})
})

// Slice 3: local mutations through the public primitives append path-stamped
// journal rows (via the shared pure builders) inside their own transaction. The
// engine reads these on push. Mirrors the memStorage reference impl.
describe('sqlite path-sync journal (write-intercept, slice 3)', () => {
	const rowsFor = async (
		s: ReturnType<typeof sqliteStorage>,
		path: string
	): Promise<Array<{ kind: string; version: string; contentHash?: string }>> => {
		const rows = await s.caps!.journal!.readFrom(0, 1000)
		return rows
			.filter((r) => r.change.path === path)
			.map((r) => ({
				kind: r.change.kind,
				version: r.change.version,
				contentHash: r.change.kind === 'put' ? r.change.contentHash : undefined
			}))
	}

	it('journals a dir put at version 1', async () => {
		const s = makeSqlite()
		await volume(s).mkdir('/a')
		expect(await rowsFor(s, '/a')).toEqual([{ kind: 'put', version: '1', contentHash: undefined }])
	})

	it('journals a regular file with its contentHash in exactly one put', async () => {
		const s = makeSqlite()
		await volume(s).writeFile('/f', bytes('hello'))
		const rows = await rowsFor(s, '/f')
		// Write-then-publish (docs/write-then-publish.html): the bytes are durable
		// and the contentHash known BEFORE the claim, so atomicCreate's own journal
		// call carries it immediately — there is no separate, content-less create
		// row followed by a second one once hashed.
		expect(rows.length).toBe(1)
		expect(rows[0].kind).toBe('put')
		expect(rows[0].contentHash).toMatch(/^[0-9a-f]{64}$/)
	})

	it('journals a delete and fast-forwards the tombstone (resurrection sorts above it)', async () => {
		const s = makeSqlite()
		const vol = volume(s)
		await vol.writeFile('/f', bytes('v1')) // put@1
		await vol.rm('/f') // delete@2
		await vol.writeFile('/f', bytes('v2')) // put@3 (> tombstone)
		expect((await rowsFor(s, '/f')).map((r) => `${r.kind}@${r.version}`)).toEqual([
			'put@1',
			'delete@2',
			'put@3'
		])
	})

	it('honours an explicit version pin (import/replay)', async () => {
		const s = makeSqlite()
		const vol = volume(s)
		await vol.mkdir('/a') // put@1
		const ino = (await vol.stat('/a')).ino
		await s.setMeta(ino, { mode: 0o700 }, { version: 99 })
		expect((await rowsFor(s, '/a')).map((r) => r.version)).toEqual(['1', '99'])
	})

	it('pages via readFrom and reports head', async () => {
		const s = makeSqlite()
		const vol = volume(s)
		await vol.mkdir('/a')
		await vol.mkdir('/b')
		await vol.mkdir('/c')
		expect(await s.caps!.journal!.head()).toBe(3)
		expect((await s.caps!.journal!.readFrom(0, 2)).map((r) => r.seq)).toEqual([1, 2])
		expect((await s.caps!.journal!.readFrom(2, 2)).map((r) => r.seq)).toEqual([3])
	})

	it('records local writes with no localSource tag', async () => {
		const s = makeSqlite()
		await volume(s).mkdir('/a')
		const [row] = await s.caps!.journal!.readFrom(0, 1)
		expect(row.localSource).toBeUndefined() // set only by the remote apply seam (slice 4)
	})
})

// #321: atomicCreate previously hardcoded content_hash=NULL and size=0 for a
// regular file, silently discarding any pre-set values in `meta` — the SQLite
// backend was the one real backend that did NOT honour write-then-publish
// (docs/write-then-publish.html in the repo root's docs/). mem.ts and idb.ts
// already spread `meta` verbatim; this pins the SQLite backend to the same
// contract now that it does too.
describe('sqlite write-then-publish: atomicCreate stages its content inside the claim', () => {
	it('a fresh write commits its content inside the claim, never through the VFS or a later putBlob', async () => {
		// Both counters being zero IS the assertion (#323): a `putByHash` from the VFS would
		// mean a blob committed to `fs_contents` with no inode referencing it — the window a
		// `gcUnreferenced()` sweep correctly reclaims — and a `putBlob` would mean the old
		// create-then-fill order, where the name exists before its content does.
		const s = makeSqlite()
		let putByHashCalls = 0
		let putBlobCalls = 0
		const tracked = {
			...s,
			caps: {
				...s.caps,
				content: {
					...s.caps!.content!,
					putByHash: async (hash: string, data: Uint8Array) => {
						putByHashCalls++
						return s.caps!.content!.putByHash(hash, data)
					}
				}
			},
			putBlob: async (...args: Parameters<typeof s.putBlob>) => {
				putBlobCalls++
				return s.putBlob(...args)
			}
		}
		const vol = volume(tracked)
		await vol.writeFile('/id', bytes('hello'))
		expect(putByHashCalls).toBe(0)
		expect(putBlobCalls).toBe(0)
		// …and the content is there anyway, with real size/hash on the claim's own row.
		expect(text(await vol.readFile('/id'))).toBe('hello')
		const st = await vol.stat('/id')
		expect(st.contentHash).toMatch(/^[0-9a-f]{64}$/)
		expect(st.size).toBe(5n)
	})

	it('a loser of an exclusive-write race never observes a transiently empty file', async () => {
		const vol = volume(makeSqlite())
		let loserRead: string | undefined
		const attempt = (label: string) =>
			vol.writeFile('/id', bytes(label), { exclusive: true }).catch(async () => {
				loserRead = text(await vol.readFile('/id'))
			})
		await Promise.all([attempt('a'), attempt('b')])
		expect(loserRead).toBeDefined()
		expect(loserRead).toMatch(/^[ab]$/) // never empty, never garbage
	})

	it('a lost claim stages nothing at all — there is no orphan blob to reclaim', async () => {
		// The loser's candidate content used to be committed before the claim was even
		// attempted, leaving an orphan for `gcUnreferenced()` to mop up. Staging inside the
		// claim means the loser writes nothing — a stronger property than reclaiming it after.
		const s = makeSqlite()
		const vol = volume(s)
		const results = await Promise.allSettled([
			vol.writeFile('/id', bytes('AAAA'), { exclusive: true }),
			vol.writeFile('/id', bytes('BBBB'), { exclusive: true })
		])
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
		const winner = text(await vol.readFile('/id'))
		expect(['AAAA', 'BBBB']).toContain(winner)
		expect(await s.caps!.content!.gcUnreferenced!()).toBe(0) // nothing was orphaned
		expect(text(await vol.readFile('/id'))).toBe(winner)
	})

	it('a sweep immediately before the claim cannot reclaim the create content', async () => {
		// #323 on the backend that actually runs a scheduled sweep: frieren's DO alarm calls
		// gcUnreferenced() daily against this storage, the same one every live write uses.
		const s = makeSqlite()
		const content = s.caps?.content
		const atomicCreate = s.caps?.atomicCreate
		if (!content || !atomicCreate) throw new Error('sqlite must offer content + atomicCreate')
		let sweeps = 0
		const tracked = {
			...s,
			caps: {
				...s.caps,
				atomicCreate: async (...args: Parameters<typeof atomicCreate>) => {
					sweeps++
					await content.gcUnreferenced()
					return atomicCreate(...args)
				}
			}
		}
		const vol = volume(tracked)
		await vol.writeFile('/note.md', bytes('hello'))
		expect(sweeps).toBeGreaterThan(0)
		expect(text(await vol.readFile('/note.md'))).toBe('hello')
	})
})

// The R2 path, which nothing exercised before: `storeContentIfMissing` only reaches
// `blobStore.put` for content that is neither text nor absent, and `makeSqlite()` passes
// no blobStore at all, so every earlier test went inline.
//
// It matters because that `put` is a NETWORK round trip, and on the Durable Object
// `DbAdapter.transaction` is `await fn(adapter)` with no rollback whatsoever
// (apps/frieren/worker/db.do.ts says so). An external await between "the name is free"
// and "the name is mine" is therefore a TOCTOU that a competing claim can win, and the
// loser cannot undo the rows it already inserted.
function makeSqliteWithR2() {
	const db = new DatabaseSync(':memory:')
	db.exec(schema)
	const db64 = {
		prepare(sql: string) {
			const stmt = db.prepare(sql)
			stmt.setReadBigInts(true)
			return stmt
		},
		exec: (sql: string) => db.exec(sql)
	}
	const objects = new Map<string, Uint8Array>()
	let gate: (() => void) | undefined
	const blobStore = {
		put: async (key: string, data: Uint8Array) => {
			// A round trip long enough for another request to be scheduled — the whole
			// point. `gate` lets a test decide what happens inside the window.
			gate?.()
			await new Promise((resolve) => setTimeout(resolve, 0))
			objects.set(key, data.slice())
			return null
		},
		get: async (key: string) => {
			const data = objects.get(key)
			return data ? { arrayBuffer: async () => data.buffer } : null
		},
		delete: async (key: string) => {
			objects.delete(key)
		}
	}
	// The DO's adapter, faithfully: `transaction` is `await fn(adapter)` with NO
	// BEGIN/COMMIT, so no isolation and no rollback (apps/frieren/worker/db.do.ts). That
	// is the whole reason an external await inside a claim is dangerous, and the plain
	// node:sqlite adapter cannot model it — its real transactions reject a nested one
	// outright ("cannot start a transaction within a transaction"), hiding exactly the
	// interleaving production allows.
	const real = createSqliteAdapter(db64 as unknown as Parameters<typeof createSqliteAdapter>[0])
	const doLike = {
		...real,
		transaction: async (fn: (tx: typeof real) => Promise<void>) => {
			await fn(real)
		}
	}
	const s = sqliteStorage(doLike as typeof real, {
		blobStore: blobStore as unknown as NonNullable<Parameters<typeof sqliteStorage>[1]>['blobStore']
	})
	return { storage: s, objects, setGate: (fn: () => void) => (gate = fn) }
}

// Binary: a NUL byte makes inferText bail, so this routes to R2 rather than inline.
const binary = (marker: number) => new Uint8Array([marker, 0, 1, 2, 3, marker])

describe('sqlite atomicCreate with R2-routed content', () => {
	it('round-trips content that routes to R2 rather than inline', async () => {
		const { storage: s, objects } = makeSqliteWithR2()
		const vol = volume(s)
		await vol.writeFile('/blob.bin', binary(7))
		expect(objects.size).toBe(1) // it really took the R2 path
		expect([...(await vol.readFile('/blob.bin'))]).toEqual([...binary(7)])
	})

	it('a claim taken during the R2 upload loses with EEXIST, not a constraint error', async () => {
		// The window: check the name, await R2, insert. The sniping writer uses TEXT content so
		// it routes inline and can finish — dirent row and all — entirely inside that await;
		// binary content would just queue behind the same gate and prove nothing.
		//
		// With no rollback available (the DO's `transaction` is `await fn(adapter)`), the loser
		// must not have inserted anything yet, and must fail as EEXIST — `writeFile`'s
		// plain-create retry matches on exactly that, so a raw UNIQUE-constraint error would
		// surface to the caller as a failed write instead of the documented overwrite.
		const { storage: s, setGate } = makeSqliteWithR2()
		const vol = volume(s)
		let sniped: Promise<void> | undefined
		setGate(() => {
			if (sniped) return
			sniped = vol.writeFile('/contested.bin', bytes('sniped inline'))
		})
		await expect(vol.writeFile('/contested.bin', binary(1))).resolves.toBeUndefined()
		await sniped
		// Whoever landed last, the path holds ONE payload intact — not an empty file, not a
		// half-written row, and exactly one dirent.
		const got = await vol.readFile('/contested.bin')
		expect([[...binary(1)], [...bytes('sniped inline')]]).toContainEqual([...got])
		expect((await vol.readdir('/')).map((e) => e.name)).toEqual(['contested.bin'])
	})

	it('an exclusive claim lost during the R2 upload reports EEXIST and stages no row', async () => {
		const { storage: s } = makeSqliteWithR2()
		const vol = volume(s)
		await vol.writeFile('/taken.bin', binary(9), { exclusive: true })
		await expect(vol.writeFile('/taken.bin', binary(8), { exclusive: true })).rejects.toThrow(
			/^EEXIST/
		)
		expect([...(await vol.readFile('/taken.bin'))]).toEqual([...binary(9)])
		// The loser's content was never recorded: nothing unreferenced to reclaim.
		expect(await s.caps!.content!.gcUnreferenced!()).toBe(0)
	})
})
