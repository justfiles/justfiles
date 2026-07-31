/**
 * A listing survives an entry vanishing mid-scan.
 *
 * `readdir` reports NAMES; each one then needs its own `lstat`, and an entry removed in
 * between must simply drop out of the listing rather than fail it. Pre-existing on the node
 * backend — any concurrent `rm` could do it — and only ever surfaced because publish temps
 * are created and unlinked constantly, which made the window easy to hit under parallel load.
 *
 * The window is opened DETERMINISTICALLY, from a wrapper that removes the entries the instant
 * `readdir` has answered. Racing a `setTimeout(0)` against the `lstat` batch is what this
 * replaces: on a fast runner the whole batch settles inside the timer's millisecond, so the
 * removal landed after the listing and the test passed while exercising nothing — and no
 * number of retries fixes a window that never opens. Hence its own file: `vi.mock` is
 * file-scoped, and `readdir` stays untouched everywhere else.
 */

import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import { nativeStorage } from './storage.fs.ts'

const hook = vi.hoisted(() => ({ afterReaddir: null as (() => void) | null }))

vi.mock('node:fs/promises', async (importOriginal) => {
	const real = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...real,
		readdir: async (path: string) => {
			const names = await real.readdir(path)
			hook.afterReaddir?.()
			return names
		}
	}
})

const root = mkdtempSync(join(tmpdir(), 'listdir-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test('a listing survives an entry vanishing mid-scan', async () => {
	const dir = join(root, 'd')
	mkdirSync(dir)
	const name = (i: number) => `n${String(i).padStart(4, '0')}.md`
	for (let i = 0; i < 400; i++) writeFileSync(join(dir, name(i)), 'x')
	const storage = await nativeStorage(dir)
	hook.afterReaddir = () => {
		for (let i = 300; i < 400; i++) unlinkSync(join(dir, name(i)))
	}

	const { entries } = await storage.listDirents(storage.rootIno, '') // rejecting here is the bug
	const listed = new Set(entries.map((e) => e.name))
	// Tolerating a vanished entry must not mean quietly dropping entries that are there:
	// everything outside the removed range is still reported.
	for (let i = 0; i < 300; i++) expect(listed.has(name(i))).toBe(true)
	expect(listed.size).toBe(300) // the window really was open — the removed 100 fell out
})
