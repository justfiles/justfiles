/**
 * Layer 1 — SyncReplica / seam units + wire-contract units.
 *
 * These target the code under test directly:
 *   - wire helpers (`syncMetaFromInode` / `inodeMetaFromSync` / `changeDigest` /
 *     `coalesceByPath`) — RED (bodies throw `not implemented`);
 *   - the adapter seams (`journaledChangeSource` / `localSyncReplica`) — RED;
 *   - the backend seams (`memStorage().caps.journal` / `.caps.pathApply`) — RED;
 *   - the LOCKED wire schema (`PathChange` / `SyncMeta` / `Version`) + numeric
 *     version helpers + `isCanonicalPath` — these are pure Phase-0 helpers and are
 *     GREEN guardrails that pin the contract.
 */

import { describe, expect, it } from 'vitest'
import type { Storage } from './storage'
import { memStorage } from './storage.mem'
import type { JournalRow, JournalStore } from './sync-replica'
import { isLocalOnlyPath, journaledChangeSource, localSyncReplica } from './sync-replica'
import { bytes, sha256 } from './sync-test-harness'
import type { PathChange, SyncMeta } from './sync-wire'
import {
	changeDigest,
	coalesceByPath,
	compareVersion,
	encodeVersion,
	inodeMetaFromSync,
	isCanonicalPath,
	PathChange as PathChangeSchema,
	parseVersion,
	syncMetaFromInode
} from './sync-wire'
import { REMOTE_SOURCE } from './synced'
import { FileType } from './types'
import { volume } from './volume'

// ── change builders (all schema-valid) ────────────────────────────────────────

type PutChange = Extract<PathChange, { kind: 'put' }>

function put(path: string, version: string, content: string, meta?: Partial<SyncMeta>): PutChange {
	const data = bytes(content)
	return {
		kind: 'put',
		path,
		version,
		contentHash: sha256(data),
		meta: {
			type: FileType.Regular,
			mode: 0o644,
			mtimeNs: '0',
			size: String(data.length),
			...meta
		}
	}
}

function dir(path: string, version: string, meta?: Partial<SyncMeta>): PathChange {
	return {
		kind: 'put',
		path,
		version,
		meta: { type: FileType.Directory, mode: 0o755, mtimeNs: '0', size: '0', ...meta }
	}
}

function del(path: string, version: string): PathChange {
	return { kind: 'delete', path, version }
}

function fakeJournalStore(rows: JournalRow[]): Storage {
	const base = memStorage()
	const journal: JournalStore = {
		async append() {},
		async readFrom(seq, limit) {
			return rows.filter((r) => r.seq > seq).slice(0, limit)
		},
		async head() {
			return rows.at(-1)?.seq ?? 0
		}
	}
	return { ...base, caps: { ...base.caps, journal } }
}

// ── Wire schema (locked; GREEN) — RED 15 ──────────────────────────────────────

describe('wire schema (PathChange)', () => {
	const PathChange = PathChangeSchema
	const dirMeta = { type: FileType.Directory, mode: 0o755, mtimeNs: '0', size: '0' }

	it('rejects a regular-file put with no contentHash', () => {
		expect(() =>
			PathChange.parse({
				kind: 'put',
				path: '/f',
				version: '1',
				meta: { type: FileType.Regular, mode: 0o644, mtimeNs: '0', size: '0' }
			})
		).toThrow()
	})

	it('rejects a dir/symlink put carrying a contentHash', () => {
		expect(() =>
			PathChange.parse({
				kind: 'put',
				path: '/d',
				version: '1',
				contentHash: 'a'.repeat(64),
				meta: dirMeta
			})
		).toThrow()
	})

	it('rejects a numeric version (must be a decimal string)', () => {
		expect(() => PathChange.parse({ kind: 'put', path: '/d', version: 1, meta: dirMeta })).toThrow()
	})

	it('rejects a non-enum file type', () => {
		expect(() =>
			PathChange.parse({ kind: 'put', path: '/d', version: '1', meta: { ...dirMeta, type: 99 } })
		).toThrow()
	})

	it('rejects the root path as a change subject', () => {
		expect(() => PathChange.parse({ kind: 'delete', path: '/', version: '1' })).toThrow()
		expect(() =>
			PathChange.parse({ kind: 'put', path: '/', version: '1', meta: dirMeta })
		).toThrow()
	})

	it('rejects a non-canonical path', () => {
		expect(() => PathChange.parse({ kind: 'delete', path: '/a/../b', version: '1' })).toThrow()
		expect(() => PathChange.parse({ kind: 'delete', path: 'a', version: '1' })).toThrow()
	})

	it('accepts a valid regular-file put (empty file included)', () => {
		expect(() => PathChange.parse(put('/f', '1', ''))).not.toThrow()
	})
})

// ── Version helpers (compare numerically, never lexically; GREEN) ─────────────

describe('version helpers', () => {
	it('compares numerically, not lexicographically', () => {
		expect(compareVersion('10', '9')).toBeGreaterThan(0)
		expect(parseVersion('10')).toBe(10)
		expect(encodeVersion(10)).toBe('10')
	})
})

describe('isCanonicalPath', () => {
	it('accepts canonical paths and rejects the rest', () => {
		expect(isCanonicalPath('/')).toBe(true)
		expect(isCanonicalPath('/a/b')).toBe(true)
		expect(isCanonicalPath('/a/')).toBe(false)
		expect(isCanonicalPath('a/b')).toBe(false)
		expect(isCanonicalPath('/a/../b')).toBe(false)
		expect(isCanonicalPath('//a')).toBe(false)
	})
})

describe('isLocalOnlyPath', () => {
	it('matches /.state itself AND /.state/**', () => {
		expect(isLocalOnlyPath('/.state')).toBe(true)
		expect(isLocalOnlyPath('/.state/sync')).toBe(true)
		expect(isLocalOnlyPath('/.stateful')).toBe(false)
		expect(isLocalOnlyPath('/notes/a')).toBe(false)
	})
})

// ── Meta encode/decode (RED) ──────────────────────────────────────────────────

describe('syncMetaFromInode / inodeMetaFromSync', () => {
	it('encodes bigint as decimal string, xattrs as base64, drops ctimeNs', () => {
		const sm = syncMetaFromInode(
			{
				type: FileType.Regular,
				size: 5n,
				mode: 0o644,
				mtimeNs: 123n,
				ctimeNs: 999n,
				contentHash: sha256('hello')
			},
			{ 'user.tag': bytes('hi') }
		)
		expect(sm.size).toBe('5')
		expect(sm.mtimeNs).toBe('123')
		expect(sm).not.toHaveProperty('ctimeNs')
		expect(sm.xattrs?.['user.tag']).toBe(Buffer.from('hi').toString('base64'))
	})

	it('round-trips through inodeMetaFromSync (ctime set locally, never from wire)', () => {
		const sm: SyncMeta = {
			type: FileType.Regular,
			mode: 0o644,
			mtimeNs: '123',
			size: '5',
			xattrs: { 'user.tag': Buffer.from('hi').toString('base64') }
		}
		const { meta, xattrs } = inodeMetaFromSync(sm)
		expect(meta.mtimeNs).toBe(123n)
		expect(meta.size).toBe(5n)
		expect(meta).not.toHaveProperty('ctimeNs')
		expect(xattrs['user.tag']).toEqual(bytes('hi'))
	})
})

// ── changeDigest (RED) — total, source-independent tie-break ──────────────────

describe('changeDigest', () => {
	it('is identical for equal durable state regardless of stamped source (RED 16)', async () => {
		const a = { ...put('/f', '7', 'SAME'), source: undefined }
		const b = { ...put('/f', '7', 'SAME'), source: 'clientA' }
		expect(await changeDigest(a)).toBe(await changeDigest(b))
	})

	it('differs when mode differs even with equal content', async () => {
		expect(await changeDigest(put('/f', '7', 'X', { mode: 0o644 }))).not.toBe(
			await changeDigest(put('/f', '7', 'X', { mode: 0o600 }))
		)
	})

	it('orders a put vs a delete at equal version', async () => {
		expect(await changeDigest(put('/f', '5', 'X'))).not.toBe(await changeDigest(del('/f', '5')))
	})

	it('differs for two dirs with different mode (no contentHash)', async () => {
		expect(await changeDigest(dir('/d', '5', { mode: 0o755 }))).not.toBe(
			await changeDigest(dir('/d', '5', { mode: 0o700 }))
		)
	})
})

// ── coalesceByPath (RED) ──────────────────────────────────────────────────────

describe('coalesceByPath', () => {
	it('collapses multiple ops on one path to its final state', () => {
		const result = coalesceByPath([put('/a', '1', 'x'), put('/b', '1', 'y'), del('/a', '2')])
		expect(result).toHaveLength(2)
		expect(result.find((c) => c.path === '/a')).toEqual(del('/a', '2'))
		expect(result.find((c) => c.path === '/b')).toEqual(put('/b', '1', 'y'))
	})
})

// ── journaledChangeSource (RED) ───────────────────────────────────────────────

describe('journaledChangeSource.pathDeltas', () => {
	it('coalesces multiple journal rows for one path to its final state', async () => {
		const cs = journaledChangeSource(
			fakeJournalStore([
				{ seq: 1, change: put('/a', '1', 'x') },
				{ seq: 2, change: put('/a', '2', 'y') }
			])
		)
		const { changes, done } = await cs.pathDeltas('', {})
		expect(changes).toEqual([put('/a', '2', 'y')])
		expect(done).toBe(true)
	})

	it('excludeOrigin drops rows authored by that origin (pull-side)', async () => {
		const cs = journaledChangeSource(
			fakeJournalStore([
				{ seq: 1, change: { ...put('/a', '1', 'x'), source: 'me' } },
				{ seq: 2, change: { ...put('/b', '1', 'y'), source: 'other' } }
			])
		)
		const { changes } = await cs.pathDeltas('', { excludeOrigin: 'me' })
		expect(changes.map((c) => c.path)).toEqual(['/b'])
	})

	it('excludeLocalSource drops rows the sync layer applied (push-side)', async () => {
		const cs = journaledChangeSource(
			fakeJournalStore([
				{ seq: 1, change: put('/a', '1', 'x'), localSource: REMOTE_SOURCE },
				{ seq: 2, change: put('/b', '1', 'y') }
			])
		)
		const { changes } = await cs.pathDeltas('', { excludeLocalSource: REMOTE_SOURCE })
		expect(changes.map((c) => c.path)).toEqual(['/b'])
	})

	it('pages: `done` is false when a full page is returned', async () => {
		const cs = journaledChangeSource(
			fakeJournalStore([
				{ seq: 1, change: put('/a', '1', 'x') },
				{ seq: 2, change: put('/b', '1', 'y') }
			])
		)
		const first = await cs.pathDeltas('', { limit: 1 })
		expect(first.done).toBe(false)
		const second = await cs.pathDeltas(first.to, { limit: 1 })
		expect(second.changes.map((c) => c.path)).toEqual(['/b'])
	})
})

// ── backend seams: memStorage journal + pathApply (RED) ───────────────────────

describe('memStorage caps.journal', () => {
	it('append then readFrom returns rows in seq order with localSource', async () => {
		const store = memStorage()
		const journal = store.caps?.journal
		if (!journal) throw new Error('no journal cap')
		await journal.append([put('/a', '1', 'x')])
		await journal.append([put('/b', '1', 'y')], REMOTE_SOURCE)
		const rows = await journal.readFrom(0, 10)
		expect(rows.map((r) => r.change.path)).toEqual(['/a', '/b'])
		expect(rows.at(-1)?.localSource).toBe(REMOTE_SOURCE)
		expect(await journal.head()).toBe(rows.at(-1)?.seq)
	})
})

describe('memStorage caps.pathApply.applyJournaled', () => {
	it('installs meta + contentHash ref and journals the change verbatim', async () => {
		const store = memStorage()
		const vol = volume(store)
		const change = put('/notes/a', '3', 'hi')
		await store.caps?.pathApply?.applyJournaled([change], { localSource: REMOTE_SOURCE })
		const st = await vol.stat('/notes/a')
		expect(st.contentHash).toBe(change.contentHash)
		const rows = await store.caps?.journal?.readFrom(0, 10)
		expect(rows?.at(-1)?.change.version).toBe('3')
		expect(rows?.at(-1)?.localSource).toBe(REMOTE_SOURCE)
	})
})

// ── localSyncReplica (RED) ────────────────────────────────────────────────────

describe('localSyncReplica', () => {
	function makeReplica(store: Storage, lazyContent = false) {
		return localSyncReplica(store, journaledChangeSource(store), {
			lazyContent,
			localActorId: 'me'
		})
	}

	it('never emits /.state or /.state/** from pathDeltas', async () => {
		const store = fakeJournalStore([
			{ seq: 1, change: put('/notes/a', '1', 'x') },
			{ seq: 2, change: dir('/.state', '1') },
			{ seq: 3, change: put('/.state/sync', '1', 's') }
		])
		const { changes } = await makeReplica(store).pathDeltas('', {})
		expect(changes.map((c) => c.path)).toEqual(['/notes/a'])
	})

	it('applies a normal put but never writes a /.state path locally', async () => {
		const store = memStorage()
		const vol = volume(store)
		const replica = makeReplica(store)
		await replica.applyPathChanges([put('/notes/a', '1', 'hi')], async () => bytes('hi'))
		await replica.applyPathChanges([put('/.state/x', '1', 's')], async () => bytes('s'))
		expect(await vol.exists('/notes/a')).toBe(true)
		expect(await vol.exists('/.state/x')).toBe(false)
	})

	it('eager applyPathChanges materialises the blob before the tree references it', async () => {
		const store = memStorage()
		const vol = volume(store)
		const replica = makeReplica(store)
		const change = put('/notes/a', '1', 'payload')
		await replica.applyPathChanges([change], async () => bytes('payload'))
		expect(await replica.hasBlobByHash(change.contentHash!)).toBe(true)
		expect(await vol.readFile('/notes/a')).toEqual(bytes('payload'))
	})

	it('putBlobByHash then getBlobByHash round-trips content by hash', async () => {
		const replica = makeReplica(memStorage())
		const data = bytes('content-addressed')
		const hash = sha256(data)
		expect(await replica.hasBlobByHash(hash)).toBe(false)
		await replica.putBlobByHash(hash, data)
		expect(await replica.hasBlobByHash(hash)).toBe(true)
		expect(await replica.getBlobByHash(hash)).toEqual(data)
	})
})
