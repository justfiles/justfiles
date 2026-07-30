/**
 * `{ exclusive: true }` on the two primitives that can take a name — and the two
 * guarantees are NOT the same size, which is the point of testing them together.
 *
 * `writeFile` is a CLAIM: the check, the create and the CONTENT are one backend
 * operation (`atomicCreate` — `O_EXCL` + `link`, one IndexedDB transaction, one
 * synchronous map mutation), so concurrent claimants are decided by the storage.
 * `exists()` + `writeFile` would be a TOCTOU, and the loser has its note overwritten
 * — these tests pin the race.
 *
 * `rename` cannot be that: no POSIX rename is both atomic and no-replace, and
 * nothing in Node reaches `renameat2`. So it is a check and THEN a move, and what it
 * promises is what these tests pin — sequential writers never overwrite each other,
 * whatever type holds the name. Racing writers are the caller's problem to order
 * (see `persistDrop` in app-notes' tree), because the alternative is emulating an
 * atomicity the platform does not have, which costs more than it buys.
 */

import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import 'fake-indexeddb/auto'
import { afterAll, describe, expect, test } from 'vitest'
import { nativeStorage } from './storage.fs.ts'
import { idbStorage } from './storage.idb.ts'
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

// Write-then-publish (docs/write-then-publish.html): a fresh create hashes and
// stores its bytes under a content-addressed key BEFORE claiming the name, so the
// claim and "the content is there" commit as one fact — see #321.
describe('write-then-publish: the claim carries its content, not a promise of it', () => {
	test('a fresh write commits content via putByHash and never calls the old putBlob-after-create path', async () => {
		let putByHashCalls = 0
		let putBlobCalls = 0
		const base = memStorage({ mintIno: () => `ino-${++next}` })
		const tracked = {
			...base,
			caps: {
				...base.caps,
				content: {
					...base.caps!.content!,
					putByHash: async (hash: string, data: Uint8Array) => {
						putByHashCalls++
						return base.caps!.content!.putByHash(hash, data)
					}
				}
			},
			putBlob: async (...args: Parameters<typeof base.putBlob>) => {
				putBlobCalls++
				return base.putBlob(...args)
			}
		}
		const vol = volume(tracked)
		await vol.writeFile('/id', enc.encode('hello'))
		expect(putByHashCalls).toBe(1)
		expect(putBlobCalls).toBe(0)
		expect(dec.decode(await vol.readFile('/id'))).toBe('hello')
	})

	test('a loser of an exclusive-write race never observes a transiently empty file', async () => {
		// Superseded across every backend by the conformance block at the bottom of this
		// file (#324); kept here for the mem-specific call-count assertions above.
		const vol = makeVol()
		let loserRead: string | undefined
		const attempt = (label: string) =>
			vol.writeFile('/id', enc.encode(label), { exclusive: true }).catch(async () => {
				loserRead = dec.decode(await vol.readFile('/id'))
			})
		await Promise.all([attempt('a'), attempt('b')])
		expect(loserRead).toMatch(/^[ab]$/)
	})

	test('a lost race leaves an orphan blob that gcUnreferenced reclaims without touching the winner', async () => {
		const storage = memStorage({ mintIno: () => `ino-${++next}` })
		const vol = volume(storage)
		const results = await Promise.allSettled([
			vol.writeFile('/id', enc.encode('AAAA'), { exclusive: true }),
			vol.writeFile('/id', enc.encode('BBBB'), { exclusive: true })
		])
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
		const winner = dec.decode(await vol.readFile('/id'))
		expect(['AAAA', 'BBBB']).toContain(winner)
		const reclaimed = await storage.caps!.content!.gcUnreferenced!()
		expect(reclaimed).toBeGreaterThanOrEqual(1) // the loser's candidate, orphaned
		expect(dec.decode(await vol.readFile('/id'))).toBe(winner) // winner untouched
	})
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
// Run against EVERY shipped local backend, on purpose: `mem` decides a claim in one
// synchronous block, IDB in one transaction, and the node backend has no `renameat2`
// and has to claim the destination with a `link`/`mkdir` of the right type — the case
// that used to fail with ENOTDIR. A contract enforced on one backend at a time goes
// unenforced on the others until whichever one happens to be under test that day.
const dirs: string[] = []
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
const nativeDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'excl-'))
	dirs.push(dir)
	return dir
}
let db = 0
const backends: Array<[string, () => Promise<ReturnType<typeof volume>>]> = [
	['mem', async () => makeVol()],
	['idb', async () => volume(await idbStorage(`excl-${++db}`))],
	['node', async () => volume(await nativeStorage(nativeDir()))]
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
	const dir = nativeDir()
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
	const dir = nativeDir()
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

test('mkdir -p passes over a folder, never over a file', async () => {
	// A caller that checks first can always be overtaken between the check and the call, so
	// the refusal belongs here: `mkdir` is where the name is taken. Reporting success while
	// a note holds the name hands back a folder that does not exist.
	const vol = volume(memStorage())
	await vol.mkdir('/Trips', { recursive: true })
	await vol.mkdir('/Trips', { recursive: true }) // a folder: idempotent, as `-p` promises
	await vol.writeFile('/Kyoto.md', enc.encode('note'))
	await expect(vol.mkdir('/Kyoto.md', { recursive: true })).rejects.toThrow(/^EEXIST/)
	// …and a file part-way along the path is ENOTDIR, naming the component that blocks.
	await expect(vol.mkdir('/Kyoto.md/Sub/Deeper', { recursive: true })).rejects.toThrow(
		/^ENOTDIR: \/Kyoto\.md$/
	)
	expect((await vol.stat('/Kyoto.md')).type).toBe(0) // still a regular file
	expect(dec.decode(await vol.readFile('/Kyoto.md'))).toBe('note')
})

// --- a create publishes its content WITH its name (#324) ---
//
// Run against every shipped local backend, and this is the whole point of the block:
// the same contract went unenforced on `nativeStorage` alone for as long as whichever
// other backend happened to be under test that day kept passing. `mem`/`idb` publish
// the bytes under their hash before claiming the name; `node` has no hash store and
// publishes with a temp file + `link`. Two mechanisms, one guarantee, one test.
describe.each(backends)('a create is atomic on %s', (_name, make) => {
	// The reader here is the shape EVERY claim loser has: resolve the path, read it,
	// use what came back. No retry, no deadline, no way to tell "still being written"
	// from "corrupt" — and it cannot have one, which is exactly why the writer owes it
	// atomicity. The intermediate states a torn writer exposes are not enumerable from
	// this side, and the last of them (a prefix that happens to parse) is silent.
	const observe = async (
		vol: Awaited<ReturnType<typeof make>>,
		path: string,
		write: Promise<void>
	): Promise<string[]> => {
		const seen: string[] = []
		let done = false
		const settled = write.then(
			() => {
				done = true
			},
			() => {
				done = true
			}
		)
		while (!done) {
			if (await vol.exists(path)) seen.push(dec.decode(await vol.readFile(path)))
			await new Promise((resolve) => setTimeout(resolve, 0))
		}
		await settled
		await write // surface a real failure rather than reporting an empty observation
		// One more after it settled, so a run that never caught the window still asserts.
		seen.push(dec.decode(await vol.readFile(path)))
		return seen
	}

	test('a concurrent reader never resolves the path and reads nothing', async () => {
		// Repeated: a timing-dependent gap shows up as an occasional bad read, not as a
		// hard failure on every run, so one pass proves nothing.
		for (let trial = 0; trial < 10; trial++) {
			const vol = await make()
			const body = `trial ${trial}`
			const seen = await observe(vol, '/id', vol.writeFile('/id', enc.encode(body)))
			expect(seen.length).toBeGreaterThan(0)
			for (const read of seen) expect(read).toBe(body)
		}
	})

	test('the loser of a claim reads the winner back immediately, with no retry', async () => {
		// The window this pins: the LOSER's catch fires the instant ITS write rejects with
		// EEXIST — independent of whether the WINNER's write has finished. Awaiting both
		// writes first can never observe the gap, because the winner's own promise only
		// resolves once its content is already committed.
		for (let trial = 0; trial < 10; trial++) {
			const vol = await make()
			let loser: string | undefined
			const attempt = (label: string) =>
				vol.writeFile('/id', enc.encode(label), { exclusive: true }).catch(async () => {
					loser = dec.decode(await vol.readFile('/id'))
				})
			await Promise.all([attempt(`a-${trial}`), attempt(`b-${trial}`)])
			expect(loser).toMatch(/^[ab]-\d+$/) // never empty, never a prefix
		}
	})

	test('appending to nothing is a create, and publishes atomically too', async () => {
		const vol = await make()
		const body = 'appended from nothing'
		const seen = await observe(vol, '/log', vol.appendFile('/log', enc.encode(body)))
		for (const read of seen) expect(read).toBe(body)
	})
})

// --- the node backend's temp file is an implementation detail, and stays one ---

test('the name is complete the instant the claim resolves', async () => {
	// The deterministic version of the races above, and the one that pins finding #11:
	// rather than hoping a poll lands inside the window, look at the exact moment the
	// claim resolves. `nativeStorage` is the backend that can expose a prefix at all —
	// mem/idb/sqlite make the bytes durable under their hash BEFORE the claim, so the
	// state is unrepresentable there (pinned by the putByHash/putBlob counts above).
	//
	// A payload spanning several of Node's 512 KiB write chunks, so create-then-fill
	// shows up as an empty file OR a nonempty prefix — the latter being exactly what a
	// reader that tolerates "empty means mid-write" would accept as real content.
	const dir = nativeDir()
	const base = await nativeStorage(dir)
	const atomicCreate = base.caps?.atomicCreate
	if (!atomicCreate) throw new Error('the native backend must offer atomicCreate')
	const body = `${'x'.repeat(3 * 512 * 1024)}END`
	let atClaim: string | undefined
	const storage = {
		...base,
		caps: {
			...base.caps,
			atomicCreate: async (...args: Parameters<typeof atomicCreate>) => {
				const ino = await atomicCreate(...args)
				// The claim has resolved, so the name is reachable. Read it straight off the
				// OS, bypassing the volume: whatever is here is what any reader would get.
				atClaim = readFileSync(join(dir, args[1]), 'utf8')
				return ino
			}
		}
	}
	await volume(storage).writeFile('/big', enc.encode(body))
	expect(atClaim).toBe(body)
})

test('a publish in flight is never listed, and leaves no residue', async () => {
	// `listDirents` is what native sync's scan+diff walks, so a visible temp name is a
	// file it would try to replicate and then find gone. Not a RED test against the old
	// code (which had no temp file at all) — it is the guard on the new mechanism.
	const dir = nativeDir()
	const vol = volume(await nativeStorage(dir))
	await vol.mkdir('/Trips')
	const write = vol.writeFile('/Trips/Kyoto.md', enc.encode('x'.repeat(2 * 512 * 1024)))
	let done = false
	const settled = write.then(
		() => {
			done = true
		},
		() => {
			done = true
		}
	)
	const listings: string[][] = []
	while (!done) {
		listings.push((await vol.readdir('/Trips')).map((e) => e.name))
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
	await settled
	await write
	expect(listings.length).toBeGreaterThan(0)
	for (const names of listings) expect(names.filter((n) => n !== 'Kyoto.md')).toEqual([])
	// And nothing is left on disk: the temp name is unlinked on either outcome.
	expect(readdirSync(join(dir, 'Trips'))).toEqual(['Kyoto.md'])
})

test('a temp file orphaned by a killed publish is an ordinary, deletable file', async () => {
	// Crash residue: the process died between writing the temp file and linking it. It is
	// NOT hidden, and that is the deliberate choice — half a note under an odd name is
	// exactly what it is, and visible means a user or a sweep can remove it, where hidden
	// would mean nothing ever could. dpkg's `.dpkg-tmp` and git's `tmp_obj_*` are visible
	// for the same reason. Only publishes actually in flight are hidden, and only from the
	// instance running them.
	const dir = nativeDir()
	writeFileSync(join(dir, '.jfs-publish-orphan'), 'half a note')
	const vol = volume(await nativeStorage(dir))
	expect((await vol.readdir('/')).map((e) => e.name)).toEqual(['.jfs-publish-orphan'])
	await vol.rm('/.jfs-publish-orphan')
	expect(readdirSync(dir)).toEqual([])
})

test('a name that merely LOOKS like a publish temp is an ordinary file', async () => {
	// The publish temp is tracked by exact path while it is in flight, NOT reserved as a
	// filename pattern. Hiding a pattern means this create succeeds and then the file is
	// unreadable, unlistable and undeletable through the volume — a write that reports
	// success and vanishes, which is a worse bug than the one publishing solves.
	const vol = volume(await nativeStorage(nativeDir()))
	await vol.writeFile('/.jfs-publish-notes.md', enc.encode('mine'))
	expect(await vol.exists('/.jfs-publish-notes.md')).toBe(true)
	expect(dec.decode(await vol.readFile('/.jfs-publish-notes.md'))).toBe('mine')
	expect((await vol.readdir('/')).map((e) => e.name)).toEqual(['.jfs-publish-notes.md'])
	await vol.rm('/.jfs-publish-notes.md')
	expect(await vol.exists('/.jfs-publish-notes.md')).toBe(false)
})

test('a publish that fails mid-write leaves no temp file behind', async () => {
	// The cleanup has to cover the whole lifecycle, not just the link: a write or close
	// that fails (ENOSPC, EIO) would otherwise strand the temp file, and repeated
	// failures would quietly consume the disk. Provoked with a payload the filesystem
	// cannot represent — a length past what the handle will accept.
	const dir = nativeDir()
	const vol = volume(await nativeStorage(dir))
	// A Proxy that reports an enormous length: `writeFile` trusts it and throws.
	const hostile = new Proxy(enc.encode('x'), {
		get: (t, p) =>
			p === 'byteLength' || p === 'length' ? Number.MAX_SAFE_INTEGER : (t as never)[p]
	}) as Uint8Array
	await expect(vol.writeFile('/doomed.md', hostile)).rejects.toThrow()
	expect(readdirSync(dir)).toEqual([]) // no residue, hidden or otherwise
})

test('a listing survives an entry vanishing mid-scan', async () => {
	// `readdir` reports NAMES; each one then needs its own `lstat`, and an entry removed
	// in between must not fail the whole listing. Pre-existing on the node backend — any
	// concurrent `rm` could do it — and only ever surfaced because publish temps are
	// created and unlinked constantly, which made the window easy to hit under 12-way
	// parallel load.
	//
	// Every `lstat` is issued in one batch, so the interleaving is driven by making the
	// directory big enough that the batch outlives a macrotask. RETRIED until the window
	// is actually observed, rather than assumed after one attempt: under load the timer
	// below can fire after the whole listing has already settled, and a run that never
	// caught a vanishing entry proves nothing. A listing that REJECTS on any attempt is
	// the bug, so the retry cannot mask it.
	const dir = nativeDir()
	const name = (i: number) => `n${String(i).padStart(4, '0')}.md`
	let observed = false
	for (let attempt = 0; attempt < 25 && !observed; attempt++) {
		const sub = join(dir, `try${attempt}`)
		mkdirSync(sub)
		for (let i = 0; i < 400; i++) writeFileSync(join(sub, name(i)), 'x')
		const storage = await nativeStorage(sub)
		const pending = storage.listDirents(storage.rootIno, '')
		await new Promise((resolve) => setTimeout(resolve, 0)) // readdir done, lstats queued
		for (let i = 300; i < 400; i++) unlinkSync(join(sub, name(i)))
		const { entries } = await pending // rejecting here is the bug, on ANY attempt
		const listed = new Set(entries.map((e) => e.name))
		// Tolerating a vanished entry must not mean quietly dropping entries that are
		// there: everything outside the removed range is still reported, every attempt.
		for (let i = 0; i < 300; i++) expect(listed.has(name(i))).toBe(true)
		observed = listed.size < 400
	}
	expect(observed).toBe(true) // the interleaving really was exercised
})
