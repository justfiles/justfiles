/**
 * `{ exclusive: true }` on the two primitives that can take a name — and the two
 * guarantees are NOT the same size, which is the point of testing them together.
 *
 * `writeFile` is a CLAIM: the check and the create are one backend operation
 * (`atomicCreate` — `O_EXCL`, one IndexedDB transaction, one synchronous map
 * mutation), so concurrent claimants are decided by the storage. `exists()` +
 * `writeFile` would be a TOCTOU, and the loser has its note overwritten — these
 * tests pin the race.
 *
 * `rename` cannot be that: no POSIX rename is both atomic and no-replace, and
 * nothing in Node reaches `renameat2`. So it is a check and THEN a move, and what it
 * promises is what these tests pin — sequential writers never overwrite each other,
 * whatever type holds the name. Racing writers are the caller's problem to order
 * (see `persistDrop` in app-notes' tree), because the alternative is emulating an
 * atomicity the platform does not have, which costs more than it buys.
 */

import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { nativeStorage } from './storage.fs.ts'
import { memStorage } from './storage.mem.ts'
import { volume } from './volume.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

// `atomicCreate` is only offered when the backend mints inodes, so pass a minter:
// that is the shipped configuration (mem, IDB and node all provide the cap).
let next = 0
const makeVol = () => volume(memStorage({ mintIno: () => `ino-${++next}` }))

test('an exclusive write creates, then refuses a taken name', async () => {
	const vol = makeVol()
	await vol.writeFile('/Kyoto.md', enc.encode('mine'), { exclusive: true })
	await expect(
		vol.writeFile('/Kyoto.md', enc.encode('theirs'), { exclusive: true })
	).rejects.toThrow(/^EEXIST/)
	expect(dec.decode(await vol.readFile('/Kyoto.md'))).toBe('mine')
	// A plain write still overwrites — the flag opts in, it does not change writeFile.
	await vol.writeFile('/Kyoto.md', enc.encode('theirs'))
	expect(dec.decode(await vol.readFile('/Kyoto.md'))).toBe('theirs')
})

test('an update edits what is there and refuses to invent it', async () => {
	// The mirror of `exclusive`, and the reason it exists: a plain write CREATES, and
	// with it every missing parent. A caller holding a path that has since been moved
	// (an editor autosaving its open note) would silently rebuild the tree it
	// remembers. The write is the only place that check has no gap.
	const vol = makeVol()
	await expect(
		vol.writeFile('/Trips/Kyoto.md', enc.encode('edited'), { update: true })
	).rejects.toThrow(/^ENOENT/)
	expect(await vol.exists('/Trips')).toBe(false) // no folder conjured on the way
	await vol.mkdir('/Trips')
	await vol.writeFile('/Trips/Kyoto.md', enc.encode('first'))
	await vol.writeFile('/Trips/Kyoto.md', enc.encode('edited'), { update: true })
	expect(dec.decode(await vol.readFile('/Trips/Kyoto.md'))).toBe('edited')
	// Gone again (the folder was renamed away) — the same edit now fails.
	await vol.rename('/Trips', '/Journeys')
	await expect(
		vol.writeFile('/Trips/Kyoto.md', enc.encode('later'), { update: true })
	).rejects.toThrow(/^ENOENT/)
	expect(await vol.exists('/Trips')).toBe(false)
	expect(dec.decode(await vol.readFile('/Journeys/Kyoto.md'))).toBe('edited')
})

test('a write whose file was removed mid-flight fails instead of storing an orphan', async () => {
	// The gap `update: true` cannot close on its own: the path resolved, and the file was
	// removed before the bytes were stored. Skipping the metadata update (what the
	// backends used to do) leaves content nothing can reach and tells the caller it saved
	// — which is how an editor clears its unsaved marker over a note that is gone.
	const vol = makeVol()
	await vol.writeFile('/Kyoto.md', enc.encode('first'))
	const ino = (await vol.stat('/Kyoto.md')).ino
	const write = vol.writeFile('/Kyoto.md', enc.encode('second'), { update: true })
	await vol.rm('/Kyoto.md') // …while those bytes are in flight
	await expect(write).rejects.toThrow(/^ENOENT/)
	expect(await vol.exists('/Kyoto.md')).toBe(false)
	// And nothing was left behind under the old inode.
	await expect(vol.readFile('/Kyoto.md')).rejects.toThrow()
	expect(ino).toBeTruthy()
})

test('a directory in the way is refused, not clobbered', async () => {
	const vol = makeVol()
	await vol.mkdir('/Trips')
	await expect(vol.writeFile('/Trips', enc.encode('x'), { exclusive: true })).rejects.toThrow(
		/^EEXIST/
	)
})

test('exactly one of N concurrent claimants wins each name', async () => {
	const vol = makeVol()
	// All 20 start before any of them finishes: the interleaving a TOCTOU loses to.
	const results = await Promise.allSettled(
		Array.from({ length: 20 }, (_, i) =>
			vol.writeFile('/Kyoto.md', enc.encode(`writer ${i}`), { exclusive: true })
		)
	)
	expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
	// And the winner's bytes are what's on disk — nobody overwrote them.
	const winner = results.findIndex((r) => r.status === 'fulfilled')
	expect(dec.decode(await vol.readFile('/Kyoto.md'))).toBe(`writer ${winner}`)
})

test('claimants racing for the same name settle on distinct numbered paths', async () => {
	// The pattern app-notes uses: on EEXIST, number up and claim again. With the
	// probe-then-write version these 10 writers would collapse onto one path.
	const vol = makeVol()
	const claim = async (body: string) => {
		for (let n = 1; ; n++) {
			const path = n === 1 ? '/Kyoto.md' : `/Kyoto ${n}.md`
			try {
				await vol.writeFile(path, enc.encode(body), { exclusive: true })
				return path
			} catch (e) {
				if (!/^E(EXIST|ISDIR)/.test((e as Error).message)) throw e
			}
		}
	}
	const paths = await Promise.all(Array.from({ length: 10 }, (_, i) => claim(`writer ${i}`)))
	expect(new Set(paths).size).toBe(10)
	for (const [i, path] of paths.entries()) {
		expect(dec.decode(await vol.readFile(path))).toBe(`writer ${i}`)
	}
})

// --- rename(..., { exclusive: true }) ---
//
// Run against BOTH shipped local backends: mem decides it in one synchronous block,
// while the node backend has no `renameat2` and has to claim the destination with a
// `link`/`mkdir` of the right type — the case that used to fail with ENOTDIR.
const dirs: string[] = []
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
const backends: Array<[string, () => Promise<ReturnType<typeof volume>>]> = [
	['mem', async () => makeVol()],
	[
		'node',
		async () => {
			const dir = mkdtempSync(join(tmpdir(), 'excl-'))
			dirs.push(dir)
			return volume(await nativeStorage(dir))
		}
	]
]

describe.each(backends)('exclusive rename on %s', (_name, make) => {
	test('an occupied destination is refused, and both notes survive', async () => {
		const vol = await make()
		await vol.writeFile('/Kyoto.md', enc.encode('theirs'))
		await vol.mkdir('/Trips')
		await vol.writeFile('/Trips/Kyoto.md', enc.encode('mine'))
		await expect(vol.rename('/Trips/Kyoto.md', '/Kyoto.md', { exclusive: true })).rejects.toThrow(
			/^EEXIST/
		)
		expect(dec.decode(await vol.readFile('/Kyoto.md'))).toBe('theirs')
		expect(dec.decode(await vol.readFile('/Trips/Kyoto.md'))).toBe('mine')
		// Without the flag it still replaces — POSIX semantics are the default.
		await vol.rename('/Trips/Kyoto.md', '/Kyoto.md')
		expect(dec.decode(await vol.readFile('/Kyoto.md'))).toBe('mine')
	})

	test('a folder moves onto a free name and is refused an occupied one', async () => {
		// The type-mismatch case: on the node backend a *file* placeholder made every
		// folder move fail with ENOTDIR, so the claim has to be a directory.
		const vol = await make()
		await vol.mkdir('/Trips')
		await vol.writeFile('/Trips/Kyoto.md', enc.encode('note'))
		await vol.rename('/Trips', '/Journeys', { exclusive: true })
		expect(dec.decode(await vol.readFile('/Journeys/Kyoto.md'))).toBe('note')
		await vol.mkdir('/Other')
		await expect(vol.rename('/Other', '/Journeys', { exclusive: true })).rejects.toThrow(/^EEXIST/)
		// A file in the way is EEXIST too — not the type error POSIX would give.
		await vol.writeFile('/Taken', enc.encode('x'))
		await expect(vol.rename('/Other', '/Taken', { exclusive: true })).rejects.toThrow(/^EEXIST/)
		expect(dec.decode(await vol.readFile('/Taken'))).toBe('x')
		expect(await vol.exists('/Other')).toBe(true)
	})

	test('a completed move leaves exactly one name for the moved file', async () => {
		// The property `noReplaceMove` promises in place of atomicity: the claim it takes
		// on the destination must not survive as a second name for the same inode.
		const vol = await make()
		await vol.mkdir('/Trips')
		await vol.writeFile('/Trips/Kyoto.md', enc.encode('note'))
		await vol.rename('/Trips/Kyoto.md', '/Kyoto.md', { exclusive: true })
		expect((await vol.readdir('/Trips')).map((e) => e.name)).toEqual([])
		expect(await vol.exists('/Trips/Kyoto.md')).toBe(false)
		expect(dec.decode(await vol.readFile('/Kyoto.md'))).toBe('note')
	})

	test('a claim numbers up over a sequence of moves into one folder', async () => {
		// What the app does with an occupied destination: try, and on EEXIST try the next
		// name. Sequential, because that is the shape of every writer in this system —
		// one drag, one agent tool call, one import loop.
		const vol = await make()
		await vol.mkdir('/Inbox')
		for (let i = 0; i < 5; i++) await vol.writeFile(`/Inbox/n${i}.md`, enc.encode(`note ${i}`))
		const claim = async (from: string) => {
			for (let n = 1; ; n++) {
				const path = n === 1 ? '/Kyoto.md' : `/Kyoto ${n}.md`
				try {
					await vol.rename(from, path, { exclusive: true })
					return path
				} catch (e) {
					if (!/^EEXIST/.test((e as Error).message)) throw e
				}
			}
		}
		const paths: string[] = []
		for (let i = 0; i < 5; i++) paths.push(await claim(`/Inbox/n${i}.md`))
		expect(paths).toEqual(['/Kyoto.md', '/Kyoto 2.md', '/Kyoto 3.md', '/Kyoto 4.md', '/Kyoto 5.md'])
		for (const [i, path] of paths.entries()) {
			expect(dec.decode(await vol.readFile(path))).toBe(`note ${i}`)
		}
		expect((await vol.readdir('/Inbox')).map((e) => e.name)).toEqual([])
	})
})

test('a write refuses a pathname that now holds a different file', async () => {
	// The native backend addresses content by inode but reaches it through a pathname,
	// and a replace-under-the-same-name (a sync client, another editor's atomic save)
	// leaves that name pointing at a stranger. A save that resolved before the swap must
	// not truncate what is there now — the handle is asked what it actually opened.
	const dir = mkdtempSync(join(tmpdir(), 'excl-'))
	dirs.push(dir)
	const storage = await nativeStorage(dir)
	const vol = volume(storage)
	await vol.writeFile('/Kyoto.md', enc.encode('mine'))
	const stale = String((await vol.stat('/Kyoto.md')).ino)
	// Renamed over, so the name keeps a DIFFERENT inode (unlink + create can reuse one).
	writeFileSync(join(dir, 'Other.md'), 'theirs')
	renameSync(join(dir, 'Other.md'), join(dir, 'Kyoto.md'))
	// Asked of the OS, not the volume: the volume caches meta by inode, which is exactly
	// the staleness this test is about.
	expect(String(statSync(join(dir, 'Kyoto.md')).ino)).not.toBe(stale)
	// A write aimed at the inode we no longer have has nothing to write to…
	await expect(storage.putBlob(stale, enc.encode('stale bytes'))).rejects.toThrow(/^ENOENT/)
	// The stranger's bytes are intact: it was neither truncated nor written.
	expect(readFileSync(join(dir, 'Kyoto.md'), 'utf8')).toBe('theirs')
})

test('a write is not a success if the name was replaced while it happened', async () => {
	// The window the pre-write check cannot cover: the swap lands after the handle was
	// verified. Those bytes went to an inode nothing can reach, so reporting success would
	// tell the caller its note is saved when the name now holds someone else's.
	const dir = mkdtempSync(join(tmpdir(), 'excl-'))
	dirs.push(dir)
	const storage = await nativeStorage(dir)
	const vol = volume(storage)
	await vol.writeFile('/Kyoto.md', enc.encode('mine'))
	const ino = String((await vol.stat('/Kyoto.md')).ino)
	// Replace the name the moment the write is in flight.
	const swap = (async () => {
		await new Promise((resolve) => setTimeout(resolve, 0))
		writeFileSync(join(dir, 'Other.md'), 'theirs')
		renameSync(join(dir, 'Other.md'), join(dir, 'Kyoto.md'))
	})()
	const writing = storage.putBlob(ino, enc.encode('a'.repeat(2_000_000)))
	await swap
	await expect(writing).rejects.toThrow(/^ENOENT/)
	expect(readFileSync(join(dir, 'Kyoto.md'), 'utf8')).toBe('theirs')
})
