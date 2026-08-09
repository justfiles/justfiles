/**
 * `appendFile` against a backend that yields between its read and its write.
 *
 * The volume's append is a read-merge-write over two storage calls, so it is only atomic
 * if nothing else writes that file in between — which is why POSIX orders a regular
 * file's writes against each other (XSH 2.9.7) and why `O_APPEND` is atomic: the kernel
 * holds that inode's lock across the seek and the write.
 *
 * A backend is free to yield in the middle. The SQLite storage hashes the content before
 * it commits, and content over the inline limit is a round trip to object storage; both
 * hand the event loop back with the append half-done. So these tests use a storage that
 * yields on `getBlob`/`putBlob` — the shape a real backend has, made deterministic.
 *
 * The ordering is per INODE. Both halves matter: the same file must not interleave, and
 * different files must still write at the same time (a whole-volume lock would be a much
 * bigger promise than a filesystem makes, and a much slower one).
 */

import type { Storage } from '@justfiles/fs/storage'
import { memStorage } from '@justfiles/fs/storage/mem'
import { describe, expect, test } from 'vitest'
import { volume } from './volume'

const bytes = (value: string) => new TextEncoder().encode(value)
const read = async (vol: ReturnType<typeof volume>, path: string) =>
	new TextDecoder().decode(await vol.readFile(path))

// Hands the event loop back around every blob call, so anything else that is ready runs
// inside a half-finished append. `seen` records which calls overlapped.
function yieldingStorage(seen: string[] = []): { storage: Storage; seen: string[] } {
	const inner = memStorage()
	const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
	return {
		seen,
		storage: {
			...inner,
			async getBlob(ino) {
				seen.push(`read:${ino}`)
				await tick()
				return inner.getBlob(ino)
			},
			async putBlob(ino, data, options) {
				await tick()
				seen.push(`write:${ino}`)
				return inner.putBlob(ino, data, options)
			}
		}
	}
}

describe('append ordering', () => {
	test('keeps both entries when two appends to one file overlap', async () => {
		const { storage } = yieldingStorage()
		const vol = volume(storage)
		await vol.writeFile('/journal.md', bytes('start'))

		await Promise.all([
			vol.appendFile('/journal.md', bytes('-a')),
			vol.appendFile('/journal.md', bytes('-b'))
		])

		// Either order is correct; losing one is not. Unordered, both appends read `start`
		// and whichever put lands last is the only entry that survives.
		expect(await read(vol, '/journal.md')).toMatch(/^start(-a-b|-b-a)$/)
	})

	test('does not let a full write vanish inside an append', async () => {
		const { storage } = yieldingStorage()
		const vol = volume(storage)
		await vol.writeFile('/note.md', bytes('old'))

		await Promise.all([
			vol.appendFile('/note.md', bytes('\nentry')),
			vol.writeFile('/note.md', bytes('edited'))
		])

		// Ordered, this is one of two outcomes: the entry landed first and the save replaced
		// it (`edited`), or the save landed first and the entry went onto it
		// (`edited\nentry`). `old\nentry` is only reachable unordered — the append read the
		// pre-edit body, the save committed, and the append's merge overwrote it, so the
		// user's typing is gone from disk while their buffer counts as saved.
		expect(['edited', 'edited\nentry']).toContain(await read(vol, '/note.md'))
	})

	test('writes different files at the same time', async () => {
		const { storage, seen } = yieldingStorage()
		const vol = volume(storage)
		await vol.writeFile('/a.md', bytes('a'))
		await vol.writeFile('/b.md', bytes('b'))
		seen.length = 0

		await Promise.all([vol.appendFile('/a.md', bytes('1')), vol.appendFile('/b.md', bytes('2'))])

		// Both reads happen before either write: the two files never wait on each other.
		// Serialising the volume rather than the inode would read, write, read, write.
		expect(seen.slice(0, 2).every((call) => call.startsWith('read:'))).toBe(true)
	})

	test('runs the append queued behind a failed one', async () => {
		const inner = memStorage()
		let fail = true
		const vol = volume({
			...inner,
			async putBlob(ino, data, options) {
				await new Promise<void>((resolve) => setTimeout(resolve, 0))
				if (fail) {
					fail = false
					throw new Error('backend unavailable')
				}
				return inner.putBlob(ino, data, options)
			}
		})
		await vol.writeFile('/log.md', bytes('start'))
		fail = true

		const [first, second] = await Promise.allSettled([
			vol.appendFile('/log.md', bytes('-a')),
			vol.appendFile('/log.md', bytes('-b'))
		])

		// One writer's failure is its own. The chain a later writer joined must not carry
		// the rejection forward and drop a write that would have succeeded.
		expect(first.status).toBe('rejected')
		expect(second.status).toBe('fulfilled')
		expect(await read(vol, '/log.md')).toBe('start-b')
	})
})
