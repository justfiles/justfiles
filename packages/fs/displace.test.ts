/**
 * The rule a rename cannot break, whatever `rename` is allowed to replace.
 *
 * POSIX rename replaces, and `Volume.rename` offers no way to refuse that — claiming a name
 * is the caller's policy (app-notes' `claimPath`), not the filesystem's. But "the caller
 * asked for a replace" is not permission to corrupt the tree while doing it, and there is
 * exactly one way for a backend to get that wrong: freeing the DISPLACED inode while another
 * directory entry still names it. The survivor then points at nothing — a dangling dirent,
 * silent until someone reads or lists it.
 *
 * `Storage.deleteInode` already states the rule ("backends should no-op if the inode is
 * still referenced by any directory entry") and says why the case is real rather than
 * theoretical: sync replay legitimately creates a transient second name during a move, so a
 * displacing rename can meet one. mem and SQLite honoured it on this path; IDB's
 * `atomicMove` called a `freeIno` helper that did not.
 *
 * So this is a CONFORMANCE test, in the shape that finds these: one rule, asked of every
 * backend that mints its own inodes, through the public API only.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import 'fake-indexeddb/auto'
import { afterAll, describe, expect, test } from 'vitest'
import { nativeStorage } from './storage.fs.ts'
import { idbStorage } from './storage.idb.ts'
import { memStorage } from './storage.mem.ts'
import type { Storage } from './storage.ts'
import { FileType } from './types.ts'
import { volume } from './volume.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

const dirs: string[] = []
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

let next = 0
let db = 0
// Not the native backend: `putDirent` there is a `rename(2)`, so a second name for one inode
// is not expressible through it (a hard link would be, and `Storage` does not offer one).
// The rule is about the backends that own their inode table, which is where the bug was.
const backends: Array<[string, () => Promise<Storage>]> = [
	['mem', async () => memStorage({ mintIno: () => `ino-${++next}` })],
	['idb', async () => idbStorage(`displace-${++db}`)]
]

describe.each(backends)('a displacing rename on %s', (_name, make) => {
	test('frees the displaced inode only when no other name still binds it', async () => {
		const storage = await make()
		const vol = volume(storage)
		await vol.writeFile('/shared.md', enc.encode('two names, one inode'))
		const ino = (await vol.stat('/shared.md')).ino

		// The transient second name `Storage` documents sync replay creating during a move.
		await storage.putDirent(storage.rootIno, 'alias.md', { ino, type: FileType.Regular })
		expect((await storage.getDirent(storage.rootIno, 'alias.md'))?.ino).toBe(ino)

		// Now replace ONE of those names. The caller asked for a replace and gets one…
		await vol.writeFile('/incoming.md', enc.encode('the mover'))
		await vol.rename('/incoming.md', '/alias.md')
		expect(dec.decode(await vol.readFile('/alias.md'))).toBe('the mover')

		// …but the OTHER name still binds that inode, so it must still resolve. Freeing it
		// here leaves `/shared.md` pointing at an inode that no longer exists.
		expect(await storage.getMeta(ino)).not.toBeNull()
		expect(dec.decode(await vol.readFile('/shared.md'))).toBe('two names, one inode')
		expect((await vol.readdir('/')).map((e) => e.name).sort()).toEqual(['alias.md', 'shared.md'])
	})

	test('still frees it when the displaced name was its only one', async () => {
		// The other half of the same rule: no reference left, so nothing is kept alive. A
		// backend that skipped the free unconditionally would leak an inode per replace.
		const storage = await make()
		const vol = volume(storage)
		await vol.writeFile('/only.md', enc.encode('sole name'))
		const doomed = (await vol.stat('/only.md')).ino
		await vol.writeFile('/incoming.md', enc.encode('the mover'))
		await vol.rename('/incoming.md', '/only.md')
		expect(dec.decode(await vol.readFile('/only.md'))).toBe('the mover')
		expect(await storage.getMeta(doomed)).toBeNull()
	})
})

test('the native backend replaces without stranding the moved inode', async () => {
	// It cannot express the case above (no hard links through `Storage`), but the ordinary
	// displace still has to leave one live name and one readable file.
	const dir = mkdtempSync(join(tmpdir(), 'displace-'))
	dirs.push(dir)
	const storage = await nativeStorage(dir)
	const vol = volume(storage)
	await vol.writeFile('/taken.md', enc.encode('theirs'))
	await vol.writeFile('/incoming.md', enc.encode('the mover'))
	await vol.rename('/incoming.md', '/taken.md')
	expect(dec.decode(await vol.readFile('/taken.md'))).toBe('the mover')
	expect((await vol.readdir('/')).map((e) => e.name)).toEqual(['taken.md'])
})
