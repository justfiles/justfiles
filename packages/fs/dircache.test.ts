/**
 * `dirCache` remembers name -> dirent lookups, and it must only ever remember a HIT.
 *
 * A cached MISS has no way to be corrected. The only thing that invalidates a stale
 * entry is `caps.subscribe`-driven cross-Volume invalidation, which reaches Volumes
 * sharing one in-process `Storage` object and nothing else — never two browser tabs,
 * two processes, or two independent `nativeStorage()`/`idbStorage()` calls over the
 * same backing store. A caller polling a path that is about to appear is then stuck on
 * an absence forever, which is a livelock rather than a wrong answer.
 *
 * `metaCache` already worked this way. `dirCache` was the asymmetric one.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import 'fake-indexeddb/auto'
import { afterAll, describe, expect, test } from 'vitest'
import { nativeStorage } from './storage.fs.ts'
import { idbStorage } from './storage.idb.ts'
import { volume } from './volume.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

const dirs: string[] = []
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

// Two INDEPENDENT Storage instances over one backing store, on purpose: that is the
// shape no invalidation can reach, and the shape a stale miss is permanent in.
let db = 0
const pairs: Array<
	[string, () => Promise<[ReturnType<typeof volume>, ReturnType<typeof volume>]>]
> = [
	[
		'idb',
		async () => {
			const name = `dircache-${++db}`
			return [volume(await idbStorage(name)), volume(await idbStorage(name))]
		}
	],
	[
		'node',
		async () => {
			const dir = mkdtempSync(join(tmpdir(), 'dircache-'))
			dirs.push(dir)
			return [volume(await nativeStorage(dir)), volume(await nativeStorage(dir))]
		}
	]
]

describe.each(pairs)('a cached absence on %s', (_name, make) => {
	test('never outlives the file appearing', async () => {
		const [reader, writer] = await make()
		expect(await reader.exists('/late.md')).toBe(false) // the miss a reader must forget
		await writer.writeFile('/late.md', enc.encode('here now'))
		expect(await reader.exists('/late.md')).toBe(true)
		expect(dec.decode(await reader.readFile('/late.md'))).toBe('here now')
	})

	test('never outlives the directory appearing', async () => {
		// The same bug one level up, and the shape that made a first-boot `mkdir -p` of a
		// nested path race into a permanent ENOENT on the parent rather than a claim.
		const [reader, writer] = await make()
		expect(await reader.exists('/.state')).toBe(false)
		await writer.mkdir('/.state', { recursive: true })
		await writer.writeFile('/.state/clientid', enc.encode('"abc"'))
		expect(await reader.exists('/.state')).toBe(true)
		expect(dec.decode(await reader.readFile('/.state/clientid'))).toBe('"abc"')
	})
})
