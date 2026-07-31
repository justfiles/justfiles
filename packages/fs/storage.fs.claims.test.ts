/**
 * A native create and a native exclusive move must take a name on ONE chain, because the
 * two are not equally atomic and the weaker one destroys the stronger. A create publishes
 * with `link`/`O_EXCL` and cannot lose a name it took; an exclusive move has to LOOK and
 * then `rename(2)`, which replaces — so a create that lands between those two steps is
 * published, reported as a success, and then overwritten by the move (#330 review).
 *
 * That window is one syscall wide, so a test cannot schedule a claim into it — and a test
 * that cannot fail would assert nothing (app-notes' DESIGN.md makes the same point about
 * ordering tests). So `rename` is stubbed to take 20ms, which widens the window without
 * changing what either operation does: the create's `link` now lands inside the move's
 * look-then-rename with certainty. Its own file, because the stub is module-scoped.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'

vi.mock('node:fs/promises', async () => {
	const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
	return {
		...real,
		rename: async (from: string, to: string) => {
			await new Promise((resolve) => setTimeout(resolve, 20))
			return real.rename(from, to)
		}
	}
})

const { nativeStorage } = await import('./storage.fs.ts')
const { volume } = await import('./volume.ts')

const enc = new TextEncoder()
const dec = new TextDecoder()

const dirs: string[] = []
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
const nativeDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'claims-'))
	dirs.push(dir)
	return dir
}

test('a create landing inside an exclusive move is refused, not overwritten', async () => {
	const dir = nativeDir()
	const vol = volume(await nativeStorage(dir))
	writeFileSync(join(dir, 'one.md'), 'moved')

	const [move, create] = await Promise.allSettled([
		vol.rename('/one.md', '/Kyoto.md', { exclusive: true }),
		vol.writeFile('/Kyoto.md', enc.encode('created'), { exclusive: true })
	])

	// Exactly one claimant holds the name — the other is told EEXIST rather than being
	// silently replaced, which is the whole promise of `{ exclusive: true }`.
	expect([move.status, create.status].filter((s) => s === 'fulfilled')).toHaveLength(1)
	if (move.status === 'fulfilled') {
		expect(dec.decode(await vol.readFile('/Kyoto.md'))).toBe('moved')
		expect(await vol.exists('/one.md')).toBe(false)
	} else {
		// The create won, so the move kept its note where it was: nothing was lost either way.
		expect(dec.decode(await vol.readFile('/Kyoto.md'))).toBe('created')
		expect(readFileSync(join(dir, 'one.md'), 'utf8')).toBe('moved')
	}
})
