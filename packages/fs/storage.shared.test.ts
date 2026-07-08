/**
 * Unit tests for the pure path-sync rules in `storage.shared.ts`.
 *
 * These functions are the nuanced, bug-prone decisions extracted OUT of the
 * `memStorage` test double so they can be shared by every owned backend
 * (mem, SQLite/DO, IDB) and tested directly here — the same logic that ships.
 */

import { describe, expect, it } from 'vitest'
import type { InodeMeta } from './storage'
import {
	buildDeleteChange,
	buildPutChange,
	joinPath,
	nextVersion,
	orderForApply,
	pathDepth,
	sortChildFirst,
	sortParentFirst,
	splitPath
} from './storage.shared'
import { sha256 } from './sync-test-harness'
import type { PathChange } from './sync-wire'
import { PathChange as PathChangeSchema } from './sync-wire'
import { FileType } from './types'

// ── Path helpers ──────────────────────────────────────────────────────────────

describe('splitPath', () => {
	it('splits into parent + name, with root parent as "/"', () => {
		expect(splitPath('/a/b/c')).toEqual({ parentPath: '/a/b', name: 'c' })
		expect(splitPath('/x')).toEqual({ parentPath: '/', name: 'x' })
	})
})

describe('joinPath', () => {
	it('joins under a dir, special-casing root', () => {
		expect(joinPath('/', 'x')).toBe('/x')
		expect(joinPath('/a/b', 'c')).toBe('/a/b/c')
	})

	it('round-trips with splitPath', () => {
		const p = '/a/b/c'
		const { parentPath, name } = splitPath(p)
		expect(joinPath(parentPath, name)).toBe(p)
	})
})

describe('pathDepth', () => {
	it('counts segments; root is 0', () => {
		expect(pathDepth('/')).toBe(0)
		expect(pathDepth('/a')).toBe(1)
		expect(pathDepth('/a/b')).toBe(2)
		expect(pathDepth('/a/b/c')).toBe(3)
	})
})

// ── Version generation ──────────────────────────────────────────────────────

describe('nextVersion', () => {
	it('is one past the current version', () => {
		expect(nextVersion(0, 0)).toBe(1)
		expect(nextVersion(5, 0)).toBe(6)
	})

	it('fast-forwards past a higher tombstone (recreate never sorts below its own delete)', () => {
		expect(nextVersion(1, 7)).toBe(8) // path_version 1, tombstoned at 7 -> 8
		expect(nextVersion(9, 7)).toBe(10) // current already ahead of tombstone
	})
})

// ── PathChange construction ───────────────────────────────────────────────────

describe('buildPutChange', () => {
	const regular = (hash?: string): InodeMeta => ({
		type: FileType.Regular,
		size: 3n,
		mode: 0o644,
		mtimeNs: 0n,
		ctimeNs: 0n,
		contentHash: hash
	})

	it('builds a schema-valid regular-file put carrying the contentHash', () => {
		const hash = sha256('hey')
		const change = buildPutChange('/f', regular(hash), {}, 3, 'me')
		expect(change).not.toBeNull()
		expect(change).toMatchObject({
			kind: 'put',
			path: '/f',
			version: '3',
			source: 'me',
			contentHash: hash
		})
		expect(() => PathChangeSchema.parse(change)).not.toThrow()
	})

	it('returns null for a fresh regular file with no content yet (putBlob journals it)', () => {
		expect(buildPutChange('/f', regular(undefined), {}, 3, 'me')).toBeNull()
	})

	it('builds a dir put with NO contentHash (schema forbids it)', () => {
		const change = buildPutChange(
			'/d',
			{ type: FileType.Directory, size: 0n, mode: 0o755, mtimeNs: 0n, ctimeNs: 0n },
			{},
			1,
			'me'
		)
		expect(change).not.toBeNull()
		expect(change).not.toHaveProperty('contentHash')
		expect(() => PathChangeSchema.parse(change)).not.toThrow()
	})

	it('builds a symlink put carrying the target and no contentHash', () => {
		const change = buildPutChange(
			'/l',
			{
				type: FileType.Symlink,
				size: 2n,
				mode: 0o777,
				mtimeNs: 0n,
				ctimeNs: 0n,
				symlinkTarget: '/t'
			},
			{},
			1,
			'me'
		)
		expect(change).toMatchObject({ kind: 'put', path: '/l' })
		expect(change && change.kind === 'put' && change.meta.symlinkTarget).toBe('/t')
		expect(() => PathChangeSchema.parse(change)).not.toThrow()
	})

	it('carries the user-xattr snapshot into the wire meta', () => {
		const change = buildPutChange(
			'/f',
			regular(sha256('x')),
			{ 'user.tag': new Uint8Array([1]) },
			1,
			'me'
		)
		expect(change && change.kind === 'put' && change.meta.xattrs).toBeDefined()
	})
})

describe('buildDeleteChange', () => {
	it('builds a schema-valid delete carrying only kind/path/version/source', () => {
		const change = buildDeleteChange('/f', 4, 'me')
		expect(change).toEqual({ kind: 'delete', path: '/f', version: '4', source: 'me' })
		expect(() => PathChangeSchema.parse(change)).not.toThrow()
	})
})

// ── Ordering ──────────────────────────────────────────────────────────────────

describe('sortChildFirst / sortParentFirst', () => {
	const paths = ['/a', '/a/b/c', '/a/b']
	it('sortChildFirst orders deepest first', () => {
		expect(sortChildFirst(paths, (p) => p)).toEqual(['/a/b/c', '/a/b', '/a'])
	})
	it('sortParentFirst orders shallowest first', () => {
		expect(sortParentFirst(paths, (p) => p)).toEqual(['/a', '/a/b', '/a/b/c'])
	})
	it('does not mutate the input array', () => {
		const input = ['/a/b', '/a']
		sortChildFirst(input, (p) => p)
		expect(input).toEqual(['/a/b', '/a'])
	})
})

describe('orderForApply', () => {
	const put = (path: string): PathChange => ({
		kind: 'put',
		path,
		version: '1',
		contentHash: sha256(path),
		meta: { type: FileType.Regular, mode: 0o644, mtimeNs: '0', size: '1' }
	})
	const dir = (path: string): PathChange => ({
		kind: 'put',
		path,
		version: '1',
		meta: { type: FileType.Directory, mode: 0o755, mtimeNs: '0', size: '0' }
	})
	const del = (path: string): PathChange => ({ kind: 'delete', path, version: '2' })

	it('puts all deletes (child-first) before all puts (parent-first)', () => {
		const ordered = orderForApply([put('/a/b/c'), dir('/a'), del('/a'), del('/a/b'), dir('/a/b')])
		const seq = ordered.map((c) => `${c.kind} ${c.path}`)
		// deletes first, child-before-parent
		expect(seq.indexOf('delete /a/b')).toBeLessThan(seq.indexOf('delete /a'))
		// then puts, parent-before-child
		expect(seq.indexOf('put /a')).toBeLessThan(seq.indexOf('put /a/b/c'))
		// every delete precedes every put
		const lastDelete = Math.max(seq.indexOf('delete /a'), seq.indexOf('delete /a/b'))
		const firstPut = Math.min(seq.indexOf('put /a'), seq.indexOf('put /a/b/c'))
		expect(lastDelete).toBeLessThan(firstPut)
	})
})
