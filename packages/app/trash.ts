import type { Volume } from '@justfiles/fs'

// Uninstalled bundles are moved here (see kernel.app.ts `uninstall`) rather than
// deleted, so an uninstall is recoverable. Entries are grouped into UTC day
// folders (`/trash/YYYY-MM-DD/<id>-<uuid>`) so the retention sweep can drop whole
// days past the window with a cheap name compare — no per-entry stat.
const TRASH_ROOT = '/trash'

// The retention the app enforces for now (not yet user-configurable): long enough
// to undo an accidental uninstall within a week, short enough that trashed bundles
// don't linger. Reinstalling is cheap (parallel download), so a week is plenty.
export const DEFAULT_TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

// UTC day key — timezone-independent and lexicographically sortable, so a string
// compare on the folder name IS a date compare.
function dayKey(atMs: number): string {
	return new Date(atMs).toISOString().slice(0, 10)
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

// Move an installed bundle into today's trash folder with one atomic rename.
export async function trashBundle(fs: Volume, from: string, appId: string): Promise<void> {
	const dir = `${TRASH_ROOT}/${dayKey(Date.now())}`
	await fs.mkdir(dir, { recursive: true })
	await fs.rename(from, `${dir}/${appId}-${crypto.randomUUID()}`)
}

// Drop every trashed day folder older than `retentionMs`. Idempotent and cheap,
// so it's safe on boot, on an interval, and on every replica (the deletes just
// sync). A day folder exactly `retentionMs` old is kept; only strictly-older days
// are purged. Non-day entries (shouldn't occur) are left untouched.
export async function sweepTrash(
	fs: Volume,
	retentionMs = DEFAULT_TRASH_RETENTION_MS,
	now = Date.now()
): Promise<void> {
	if (!(await fs.exists(TRASH_ROOT))) return
	const cutoff = dayKey(now - retentionMs)
	for (const { name } of await fs.readdir(TRASH_ROOT)) {
		if (DAY_KEY.test(name) && name < cutoff)
			await fs.rm(`${TRASH_ROOT}/${name}`, { recursive: true, force: true })
	}
}
