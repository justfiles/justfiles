// Unit tests for the SQLite backend's path-sync capability seams that don't need
// the full journal/apply stack yet: the hash-addressed `caps.content` blob store
// and the `caps.subscribe` change feed. Both run under vitest via node's built-in
// node:sqlite (no bun); see storage.sqlite.conformance.test.ts for the DbAdapter
// shim rationale.

import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { volume } from '@justfiles/fs'
import type { StorageChange } from '@justfiles/fs/storage'
import { FileType } from '@justfiles/fs/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSqliteAdapter } from './db.sqlite'
import { storage as sqliteStorage } from './storage.sqlite'

const schema = readFileSync(new URL('./migrations/0001_schema.sql', import.meta.url), 'utf8')

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
