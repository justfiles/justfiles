/**
 * Layer 1 — SyncReplica / seam units + wire-contract units.
 *
 * These target the code under test directly:
 *   - wire helpers (`syncMetaFromInode` / `inodeMetaFromSync` / `changeDigest` /
 *     `coalesceByPath`);
 *   - the adapter seams (`journaledChangeSource` / `localSyncReplica`);
 *   - the backend seams (`memStorage().caps.journal` / `.caps.pathApply`);
 *   - the LOCKED wire schema (`PathChange` / `SyncMeta` / `Version`) + numeric
 *     version helpers + `isCanonicalPath`, which pin the contract.
 */

import { describe, expect, it } from 'vitest'
import type { Storage } from './storage'
import { memStorage } from './storage.mem'
import type { JournalRow, JournalStore } from './sync-replica'
import { isHostPrivatePath, journaledChangeSource, localSyncReplica } from './sync-replica'
import { bytes, sha256, text } from './sync-test-harness'
import type { PathChange, SyncMeta } from './sync-wire'
import {
	ContentHash,
	changeDigest,
	coalesceByPath,
	compareVersion,
	encodeVersion,
	inodeMetaFromSync,
	isCanonicalPath,
	PathChange as PathChangeSchema,
	parseVersion,
	syncMetaFromInode,
	Version
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

function symlink(
	path: string,
	version: string,
	target: string,
	meta?: Partial<SyncMeta>
): PathChange {
	return {
		kind: 'put',
		path,
		version,
		meta: {
			type: FileType.Symlink,
			mode: 0o777,
			mtimeNs: '0',
			size: String(bytes(target).length),
			symlinkTarget: target,
			...meta
		}
	}
}

function makeReplica(store: Storage, lazyContent = false) {
	return localSyncReplica(store, journaledChangeSource(store), {
		lazyContent,
		localActorId: 'me'
	})
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
		},
		async adoptAllAsLocal(opts) {
			const latest = new Map(rows.map((row) => [row.change.path, row]))
			const current = [...latest.values()]
				.sort((a, b) => a.seq - b.seq)
				.filter((row) => !opts?.dropDeletes || row.change.kind === 'put')
			rows.splice(
				0,
				rows.length,
				...current.map((row, i) => ({
					...row,
					seq: (rows.at(-1)?.seq ?? 0) + i + 1,
					localSource: undefined
				}))
			)
		}
	}
	return { ...base, caps: { ...base.caps, journal } }
}

// ── Wire schema (locked) ──────────────────────────────────────────────────────

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

// ── Version helpers (compare numerically, never lexically) ────────────────────

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

describe('isHostPrivatePath', () => {
	it('matches each prefix itself AND its children', () => {
		expect(isHostPrivatePath('/.state')).toBe(true)
		expect(isHostPrivatePath('/.state/sync')).toBe(true)
		expect(isHostPrivatePath('/host')).toBe(true)
		expect(isHostPrivatePath('/host/accounts')).toBe(true)
		expect(isHostPrivatePath('/host/accounts/a%40b.json')).toBe(true)
		expect(isHostPrivatePath('/host/connections/chatgpt/default.json')).toBe(true)
	})

	it('matches per path SEGMENT — a sibling is not a child', () => {
		expect(isHostPrivatePath('/.stateful')).toBe(false)
		expect(isHostPrivatePath('/hostage')).toBe(false)
		expect(isHostPrivatePath('/hosts.md')).toBe(false)
		expect(isHostPrivatePath('/system/accounts')).toBe(false) // relocated to /host
		expect(isHostPrivatePath('/system/user.md')).toBe(false)
		expect(isHostPrivatePath('/notes/host.md')).toBe(false)
		expect(isHostPrivatePath('/notes/a')).toBe(false)
	})
})

// ── Meta encode/decode ────────────────────────────────────────────────────────

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

// ── changeDigest — total, source-independent tie-break ────────────────────────

describe('changeDigest', () => {
	it('is identical for equal durable state regardless of stamped source', async () => {
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

// ── coalesceByPath ────────────────────────────────────────────────────────────

describe('coalesceByPath', () => {
	it('collapses multiple ops on one path to its final state', () => {
		const result = coalesceByPath([put('/a', '1', 'x'), put('/b', '1', 'y'), del('/a', '2')])
		expect(result).toHaveLength(2)
		expect(result.find((c) => c.path === '/a')).toEqual(del('/a', '2'))
		expect(result.find((c) => c.path === '/b')).toEqual(put('/b', '1', 'y'))
	})
})

// ── journaledChangeSource ─────────────────────────────────────────────────────

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

// ── backend seams: memStorage journal + pathApply ─────────────────────────────

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

// ── localSyncReplica ──────────────────────────────────────────────────────────

describe('localSyncReplica', () => {
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

// ── ContentHash / Version schema breadth — issue #144 item 6 ──────────────────

describe('ContentHash / Version schema', () => {
	it('ContentHash accepts lowercase 64-hex and rejects everything else', () => {
		expect(() => ContentHash.parse(sha256('x'))).not.toThrow()
		expect(() => ContentHash.parse('A'.repeat(64))).toThrow() // uppercase
		expect(() => ContentHash.parse('a'.repeat(63))).toThrow() // too short
		expect(() => ContentHash.parse('a'.repeat(65))).toThrow() // too long
		expect(() => ContentHash.parse(`sha256-${'a'.repeat(64)}`)).toThrow() // prefixed
	})

	it('Version accepts 0 and positive decimals, rejects leading zeros / signs / empties', () => {
		expect(() => Version.parse('0')).not.toThrow()
		expect(() => Version.parse('10')).not.toThrow()
		expect(() => Version.parse('01')).toThrow() // leading zero
		expect(() => Version.parse('')).toThrow()
		expect(() => Version.parse('-1')).toThrow()
		expect(() => Version.parse('1.0')).toThrow()
	})

	it('PathChange accepts a symlink put (target, no contentHash)', () => {
		expect(() => PathChangeSchema.parse(symlink('/l', '1', '/target'))).not.toThrow()
	})
})

// ── symlink + xattr wire encode/decode — issue #144 item 6 ────────────────────

describe('syncMetaFromInode (symlink + xattr exclusion)', () => {
	it('encodes a symlink target and carries no contentHash', () => {
		const sm = syncMetaFromInode({
			type: FileType.Symlink,
			size: 7n,
			mode: 0o777,
			mtimeNs: 0n,
			ctimeNs: 0n,
			symlinkTarget: '/target'
		})
		expect(sm.type).toBe(FileType.Symlink)
		expect(sm.symlinkTarget).toBe('/target')
		expect(sm).not.toHaveProperty('contentHash')
	})

	it('excludes trusted.sync.* xattrs from the wire snapshot', () => {
		const sm = syncMetaFromInode(
			{
				type: FileType.Regular,
				size: 0n,
				mode: 0o644,
				mtimeNs: 0n,
				ctimeNs: 0n,
				contentHash: sha256('')
			},
			{ 'user.keep': bytes('k'), 'trusted.sync.baseline': bytes('secret') }
		)
		expect(sm.xattrs && Object.keys(sm.xattrs)).toEqual(['user.keep'])
	})
})

// ── changeDigest: sorted xattrs + symlink target — issue #144 item 6 ──────────

describe('changeDigest (xattrs + symlink)', () => {
	it('is order-independent over xattrs (canonically sorted)', async () => {
		const a = put('/f', '1', 'x', { xattrs: { 'user.a': 'AA', 'user.b': 'BB' } })
		const b = put('/f', '1', 'x', { xattrs: { 'user.b': 'BB', 'user.a': 'AA' } })
		expect(await changeDigest(a)).toBe(await changeDigest(b))
	})

	it('is sensitive to the symlink target', async () => {
		expect(await changeDigest(symlink('/l', '1', '/a'))).not.toBe(
			await changeDigest(symlink('/l', '1', '/b'))
		)
	})
})

// ── Filtered delta cursor progress — issue #144 item 2 ────────────────────────

describe('journaledChangeSource.pathDeltas cursor progress', () => {
	it('advances the cursor and stays not-done when a full page is entirely filtered', async () => {
		const cs = journaledChangeSource(
			fakeJournalStore([
				{ seq: 1, change: { ...put('/a', '1', 'x'), source: 'me' } },
				{ seq: 2, change: { ...put('/b', '1', 'y'), source: 'me' } }
			])
		)
		const res = await cs.pathDeltas('', { excludeOrigin: 'me', limit: 2 })
		expect(res.changes).toEqual([]) // everything filtered
		expect(res.to).toBe('2') // advance to the last RAW row, not stall at 0
		expect(res.done).toBe(false) // a full raw page => maybe more; never stall
	})

	it('advances the cursor and stays not-done when a full page is filtered by excludeLocalSource', async () => {
		const cs = journaledChangeSource(
			fakeJournalStore([
				{ seq: 1, change: put('/a', '1', 'x'), localSource: REMOTE_SOURCE },
				{ seq: 2, change: put('/b', '1', 'y'), localSource: REMOTE_SOURCE }
			])
		)
		const res = await cs.pathDeltas('', { excludeLocalSource: REMOTE_SOURCE, limit: 2 })
		expect(res.changes).toEqual([]) // everything filtered
		expect(res.to).toBe('2') // advance to the last RAW row, not stall at 0
		expect(res.done).toBe(false) // a full raw page => maybe more; never stall
	})
})

// ── PathMutationStore version/tombstone generator — issue #144 item 3 ─────────

describe('memStorage caps.pathApply version/tombstone generator', () => {
	async function lastRow(store: Storage, pred: (r: JournalRow) => boolean) {
		const rows = (await store.caps?.journal?.readFrom(0, 100)) ?? []
		return rows.findLast(pred)
	}

	it('journals the incoming change verbatim (version + origin source preserved)', async () => {
		const store = memStorage()
		await store.caps?.pathApply?.applyJournaled([{ ...put('/a', '5', 'x'), source: 'origin' }], {
			localSource: REMOTE_SOURCE
		})
		const row = await lastRow(store, (r) => r.change.path === '/a')
		expect(row?.change.version).toBe('5')
		expect(row?.change.source).toBe('origin')
		expect(row?.localSource).toBe(REMOTE_SOURCE)
	})

	it('fast-forwards path_version so a later local edit exceeds the applied version', async () => {
		const store = memStorage()
		const vol = volume(store)
		await store.caps?.pathApply?.applyJournaled([put('/a', '5', 'x')], {
			localSource: REMOTE_SOURCE
		})
		await vol.writeFile('/a', bytes('local-edit'))
		const local = await lastRow(store, (r) => r.change.path === '/a' && !r.localSource)
		expect(Number(local?.change.version)).toBe(6)
	})

	it('versions a recreate above the tombstone of a prior delete', async () => {
		const store = memStorage()
		const vol = volume(store)
		await store.caps?.pathApply?.applyJournaled([put('/a', '5', 'x')], {
			localSource: REMOTE_SOURCE
		})
		await store.caps?.pathApply?.applyJournaled([del('/a', '7')], { localSource: REMOTE_SOURCE })
		await vol.writeFile('/a', bytes('recreated'))
		const recreate = await lastRow(
			store,
			(r) => r.change.path === '/a' && r.change.kind === 'put' && !r.localSource
		)
		expect(Number(recreate?.change.version)).toBeGreaterThan(7)
	})
})

// ── Apply / journal ordering invariants — issue #144 item 5 ───────────────────

describe('ordering invariants', () => {
	it('applies an unsorted batch parent-before-child so no child is orphaned', async () => {
		const store = memStorage()
		const vol = volume(store)
		await makeReplica(store).applyPathChanges(
			[put('/a/b/c', '1', 'x'), dir('/a/b', '1'), dir('/a', '1')],
			async () => bytes('x')
		)
		expect((await vol.stat('/a/b')).type).toBe(FileType.Directory)
		expect(text(await vol.readFile('/a/b/c'))).toBe('x')
	})

	it('type replacement orders the recursive delete before the new put', async () => {
		const store = memStorage()
		const vol = volume(store)
		const r = makeReplica(store)
		await r.applyPathChanges([put('/p', '1', 'file')], async () => bytes('file'))
		await r.applyPathChanges(
			[del('/p', '2'), dir('/p', '3'), put('/p/child', '3', 'c')],
			async () => bytes('c')
		)
		expect((await vol.stat('/p')).type).toBe(FileType.Directory)
		expect(text(await vol.readFile('/p/child'))).toBe('c')
	})

	it('journals a directory rename as delete(child-first) then put(parent-first)', async () => {
		const store = memStorage()
		const vol = volume(store)
		await vol.mkdir('/old/sub', { recursive: true })
		await vol.writeFile('/old/sub/f', bytes('x'))
		const head = (await store.caps?.journal?.head()) ?? 0
		await vol.rename('/old', '/new')
		const rows = (await store.caps?.journal?.readFrom(head, 100)) ?? []
		const seq = rows.map((r) => `${r.change.kind} ${r.change.path}`)
		const at = (s: string) => seq.indexOf(s)
		// deletes: child before parent
		expect(at('delete /old/sub/f')).toBeLessThan(at('delete /old/sub'))
		expect(at('delete /old/sub')).toBeLessThan(at('delete /old'))
		// puts: parent before child
		expect(at('put /new')).toBeLessThan(at('put /new/sub'))
		expect(at('put /new/sub')).toBeLessThan(at('put /new/sub/f'))
		// all deletes precede all puts
		expect(
			Math.max(at('delete /old'), at('delete /old/sub'), at('delete /old/sub/f'))
		).toBeLessThan(Math.min(at('put /new'), at('put /new/sub'), at('put /new/sub/f')))
	})
})

// ── Complete xattr snapshot on apply — issue #144 item 6 ──────────────────────

describe('localSyncReplica xattr snapshot', () => {
	it('replaces the whole user-xattr set and never touches trusted.sync.*', async () => {
		const store = memStorage()
		const vol = volume(store)
		const r = makeReplica(store)
		await r.applyPathChanges(
			[put('/f', '1', 'x', { xattrs: { 'user.a': 'QQ', 'user.b': 'RR' } })],
			async () => bytes('x')
		)
		await vol.setXattr('/f', 'trusted.sync.local', bytes('keep'))
		await r.applyPathChanges([put('/f', '2', 'x', { xattrs: { 'user.a': 'SS' } })], async () =>
			bytes('x')
		)
		const names = (await vol.listXattr('/f')).sort()
		expect(names).toContain('user.a')
		expect(names).not.toContain('user.b') // absent from the snapshot => deleted
		expect(await vol.getXattr('/f', 'trusted.sync.local')).toEqual(bytes('keep')) // local-only
	})
})
