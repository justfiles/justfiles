import { sweepTrash } from '@justfiles/app'
import type { Volume } from '@justfiles/fs'
import type { Store } from '@justfiles/fs/store'

// A storage sweep that ran out of budget leaves this marker and re-arms the alarm,
// so the next wake is a CONTINUATION rather than a new day. Durable, because that
// wake may land on a fresh instance.
const SWEEP_RESUME_KEY = 'fs:sweep:resume'
// Long enough that a resumed sweep is not a hot loop, short enough that a large
// backlog drains in minutes rather than days.
const SWEEP_RESUME_DELAY_MS = 60_000

/** The slice of Durable Object storage this routine drives (see `runDailyMaintenance`). */
interface SweepState {
	get<T>(key: string): Promise<T | undefined>
	put(key: string, value: boolean): Promise<void>
	delete(key: string): Promise<boolean>
	setAlarm(at: number): Promise<void>
}

/**
 * The storage half of the daily routine, plus its own continuation.
 *
 * Every store the host holds is swept, not just the synced one: rule 7 makes content
 * immutable, so an edited file simply stops naming its old bytes — and the bytes
 * behind `/private` go stale exactly the way the tree's do.
 *
 * The sweep takes a bounded slice per run — it shares one Durable Object event with
 * every other write, so it cannot be allowed to grow with the backlog. When any store
 * reports work remaining, this re-arms the alarm itself instead of waiting a day,
 * which a large backlog would never drain.
 *
 * `daily` says whether this wake is the DAILY one. A resumed sweep is not: the
 * caller's other daily work (the agent rolls yesterday's notes into memory, and
 * builds its runtime to do it) must run once a day, not once a minute.
 */
export async function runDailyMaintenance(
	stores: readonly Store[],
	volume: Volume,
	state: SweepState,
	now = Date.now()
): Promise<{ daily: boolean }> {
	const resuming = (await state.get<boolean>(SWEEP_RESUME_KEY)) === true
	// Cheap and idempotent (a readdir of /trash), so a continuation may re-run it.
	await sweepTrash(volume).catch(() => {})
	// A failed (or absent) sweep reports nothing: it retries on the next daily alarm,
	// and a backend that cannot sweep has nothing to come back for.
	const swept = await Promise.all(stores.map((store) => store.gc?.().catch(() => undefined)))
	if (swept.some((pass) => pass?.done === false)) {
		// Alarm first, marker second: a failed re-arm must not leave a marker behind
		// that would silently skip the next day's agent maintenance.
		await state.setAlarm(now + SWEEP_RESUME_DELAY_MS)
		await state.put(SWEEP_RESUME_KEY, true)
	} else if (resuming) await state.delete(SWEEP_RESUME_KEY)
	return { daily: !resuming }
}

// NO AVATAR SWEEP. Derived faces live in `<avatar>/.gen/<hash of resting>/`, so replacing an
// avatar's resting file orphans one DIRECTORY — and the generator takes the siblings out
// before it writes the current one (src/agent/faces.ts). Stale art is collected by the next
// generation instead of by a scheduled job, which is what the authored/derived split buys:
// worst case one orphan directory sits until the next expression tag, against a daily task
// and a filename grammar we no longer have to parse. Installed avatars are NEVER pruned —
// a pack, or the user's own photo, is their property.
