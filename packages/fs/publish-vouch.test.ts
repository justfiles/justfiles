/**
 * A publish vouches for the file it left, never for the name.
 *
 * `rename` takes the name in one operation, but the state describing what landed is a
 * separate `lstat` — and `echo x > f` truncates IN PLACE and keeps the inode, so a check
 * that only asked whose inode it was would hand a local writer's bytes back wearing the
 * placement's identity. The store records the row's hash beside that state, `observe` finds
 * it unchanged, and `blobs` answers those bytes under a key that does not name them (rule 7).
 *
 * The window is opened DETERMINISTICALLY, from a wrapper that edits the file the instant
 * `rename` has answered — there is no seam inside `publish` for a fake `Disk` to reach, and
 * racing a real writer against two adjacent syscalls exercises nothing on a fast machine.
 * Hence its own file: `vi.mock` is file-scoped, and `rename` stays untouched everywhere else.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import { AT_ROOT, fsDisk, under } from './disk'

const hook = vi.hoisted(() => ({ afterRename: null as (() => void) | null }))

vi.mock('node:fs/promises', async (importOriginal) => {
	const real = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...real,
		rename: async (from: string, to: string) => {
			await real.rename(from, to)
			hook.afterRename?.()
		}
	}
})

const root = mkdtempSync(join(tmpdir(), 'jfs-publish-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test('a publish claims nothing about a file edited in place under it', async () => {
	const disk = fsDisk(root)
	const at = under(AT_ROOT, 'f.txt')
	if (at === null) throw new Error('unreachable')
	const os = join(root, 'f.txt')

	let landedIno = 0n
	hook.afterRename = () => {
		hook.afterRename = null
		landedIno = statSync(os, { bigint: true }).ino
		writeFileSync(os, 'typed by a local tool')
	}
	const seen = await disk.write(at, new TextEncoder().encode('mine'))

	expect(seen).toBeNull()
	// And the inode really did survive the edit, so an inode check alone would have
	// vouched for the local tool's bytes as this store's placement.
	expect(statSync(os, { bigint: true }).ino).toBe(landedIno)
})
