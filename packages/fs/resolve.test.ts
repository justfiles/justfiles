/**
 * Path resolution: what a path RESOLVES to, as opposed to how it was spelled.
 * Every operation on a volume goes through the same walk, and anything that
 * compares paths textually (the recursive `watch` scope, `chroot`) has to agree
 * with it — a disagreement is a silent miss, not an error.
 *
 * (`volume.test.js` covers the wider surface but is a `bun:test` file that no CI
 * job runs, so resolution has no coverage in the vitest suite.)
 */

import { describe, expect, it } from 'vitest'
import { memStorage } from './storage.mem'
import { volume } from './volume'

const enc = new TextEncoder()

describe('resolution', () => {
	it('lands on the parent when a path ends in ..', async () => {
		const vol = volume(memStorage())
		await vol.mkdir('/notes/trips', { recursive: true })

		const notes = await vol.stat('/notes')
		// The last component consumed is `trips`, but the path does not end there.
		expect((await vol.stat('/notes/trips/..')).ino).toBe(notes.ino)
		expect((await vol.stat('/notes/trips/../')).ino).toBe(notes.ino)
		expect((await vol.stat('/notes/trips/../trips/..')).ino).toBe(notes.ino)
		expect((await vol.stat('/notes/..')).ino).toBe((await vol.stat('/')).ino)
	})

	it('lands on the target when a path goes through a symlinked directory', async () => {
		const vol = volume(memStorage())
		await vol.mkdir('/notes/trips', { recursive: true })
		await vol.writeFile('/notes/trips/kyoto.md', enc.encode('go'))
		await vol.symlink('/notes', '/alias')

		expect((await vol.stat('/alias/trips')).ino).toBe((await vol.stat('/notes/trips')).ino)
		await vol.writeFile('/alias/trips/kyoto.md', enc.encode('edited'))
		expect(new TextDecoder().decode(await vol.readFile('/notes/trips/kyoto.md'))).toBe('edited')
	})
})
