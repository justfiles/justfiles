/**
 * `fake-indexeddb/auto` MUST be imported before `storage.idb` (its module-load
 * `IDBKeyRange` capture reads the global) — see sync-conformance.test.ts.
 *
 * Pins the fix for a Codex finding on #322: `atomicCreate` previously never
 * marked a freshly created, content-bearing inode dirty (only `putBlob` did),
 * so `evictContent`'s "never reclaim a dirty inode's bytes" guarantee never
 * applied to a file created via write-then-publish (#321) — the fast path that
 * skips the trailing `putBlob`. A brand-new, not-yet-synced file's content was
 * silently eligible for LRU eviction the moment ANY other write pushed total
 * content past the cap, not just in a narrow race window.
 */

import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vitest'
import { idbStorage } from './storage.idb'
import { volume } from './volume'

const enc = new TextEncoder()
const dec = new TextDecoder()

describe('idbStorage: a fresh write-then-publish create is protected from LRU eviction', () => {
	test('survives an eviction sweep triggered by a later, unrelated large write', async () => {
		const storage = idbStorage(`dirty-${crypto.randomUUID()}`, { contentCapBytes: 20 })
		const vol = volume(storage)
		// Created via writeFile's create branch — the write-then-publish fast path,
		// since idbStorage always has caps.content.
		await vol.writeFile('/keep.txt', enc.encode('keep me'))
		// Alone exceeds the tiny cap, forcing evictContent to run on this write.
		await vol.writeFile('/big.txt', enc.encode('x'.repeat(30)))
		expect(dec.decode(await vol.readFile('/keep.txt'))).toBe('keep me')
	})

	test('an updated (not just created) file is also protected, unaffected by the fix', async () => {
		const storage = idbStorage(`dirty-${crypto.randomUUID()}`, { contentCapBytes: 20 })
		const vol = volume(storage)
		await vol.writeFile('/keep.txt', enc.encode('v1'))
		await vol.writeFile('/keep.txt', enc.encode('keep me')) // update path, always through putBlob
		await vol.writeFile('/big.txt', enc.encode('x'.repeat(30)))
		expect(dec.decode(await vol.readFile('/keep.txt'))).toBe('keep me')
	})
})
