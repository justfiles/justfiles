/**
 * `dirCache` must never remember a MISS. A hit going stale is recoverable (the
 * next real read/write sees fresh data); a stale miss is not — nothing revisits
 * it, so it live-locks any Volume that once observed "doesn't exist yet" for a
 * name a DIFFERENT Storage instance (a different browser tab, process, or
 * `idbStorage()`/`nativeStorage()` call over the same backing store) went on to
 * create. `storage.caps.subscribe`-based cross-Volume invalidation only reaches
 * Volumes sharing one in-process Storage object — it cannot save a caller that
 * doesn't share one, which is exactly the shape every scenario below rules out.
 *
 * `fake-indexeddb/auto` MUST be imported before `storage.idb` (its module-load
 * `IDBKeyRange` capture reads the global) — see sync-conformance.test.ts.
 */

import 'fake-indexeddb/auto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { nativeStorage } from './storage.fs'
import { idbStorage } from './storage.idb'
import { volume } from './volume'

const enc = new TextEncoder()

describe('dirCache never caches a miss (idb, two independent Storage instances over the same db)', () => {
	test('a plain exists() poll observes a DIFFERENT instance creating the file', async () => {
		const dbName = `poll-${crypto.randomUUID()}`
		const reader = volume(idbStorage(dbName))
		const writer = volume(idbStorage(dbName))
		expect(await reader.exists('/marker')).toBe(false) // would cache the miss, pre-fix
		await writer.writeFile('/marker', enc.encode('x'))
		expect(await reader.exists('/marker')).toBe(true)
	})

	test('a losing recursive mkdir does not leave the loser stuck believing its own parent is gone', async () => {
		const dbName = `tabrace-${crypto.randomUUID()}`
		const a = volume(idbStorage(dbName))
		const b = volume(idbStorage(dbName))
		await Promise.all([
			a.mkdir('/.state', { recursive: true }),
			b.mkdir('/.state', { recursive: true })
		])
		// Pre-fix: b's own earlier miss on '.state' (cached before it lost the create
		// race) survives its swallowed EEXIST, so this throws a spurious ENOENT instead
		// of reaching the write at all.
		await expect(
			b.writeFile('/.state/clientid', enc.encode('"x"'), { exclusive: true })
		).resolves.not.toThrow()
	})
})

describe('dirCache never caches a miss (nativeStorage, two independent instances over the same directory)', () => {
	test('a losing recursive mkdir does not leave the loser stuck believing its own parent is gone', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'dircache-'))
		try {
			const a = volume(await nativeStorage(dir))
			const b = volume(await nativeStorage(dir))
			await Promise.all([
				a.mkdir('/.state', { recursive: true }),
				b.mkdir('/.state', { recursive: true })
			])
			await expect(
				b.writeFile('/.state/clientid', enc.encode('"x"'), { exclusive: true })
			).resolves.not.toThrow()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
