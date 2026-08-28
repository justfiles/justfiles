import { sweepTrash } from '@justfiles/app'
import type { Volume } from '@justfiles/fs'
import { ROOT, type Store } from '@justfiles/fs/store'

// A storage sweep that ran out of budget leaves this marker and re-arms the alarm,
// so the next wake is a CONTINUATION rather than a new day. Durable, because that
// wake may land on a fresh instance.
const SWEEP_RESUME_KEY = 'fs:sweep:resume'
const ACTIVITY_SWEEP_KEY = 'activity:sweep'
// Long enough that a resumed sweep is not a hot loop, short enough that a large
// backlog drains in minutes rather than days.
const SWEEP_RESUME_DELAY_MS = 60_000
const ACTIVITY_DETAIL_ROOT = '/private/cache/agent-activity'
const ACTIVITY_DETAIL_TTL_MS = 30 * 24 * 60 * 60 * 1_000
const ACTIVITY_DETAIL_STORE_LIMIT = 100 * 1_024 * 1_024
const ACTIVITY_SWEEP_WORK_LIMIT = 256
const ACTIVITY_SWEEP_EVICT_BATCH = 128

type ActivityDetailLimits = {
	ttlMs: number
	storeLimit: number
	workLimit?: number
	evictBatch?: number
}

type ActivityFile = { path: string; size: string; mtimeNs: string }
type ActivitySweep = {
	phase: 'age' | 'limit'
	cutoffNs: string
	stack: { id: string; path: string; cursor?: string }[]
	total: string
	oldest: ActivityFile[]
}

/** The slice of Durable Object storage this routine drives (see `runDailyMaintenance`). */
interface SweepState {
	get<T>(key: string): Promise<T | undefined>
	put<T>(key: string, value: T): Promise<void>
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
	activityStore: Store,
	state: SweepState,
	now = Date.now()
): Promise<{ daily: boolean }> {
	const resuming = (await state.get<boolean>(SWEEP_RESUME_KEY)) === true
	// Cheap and idempotent (a readdir of /trash), so a continuation may re-run it.
	await sweepTrash(volume).catch(() => {})
	const activityState = await state.get<ActivitySweep>(ACTIVITY_SWEEP_KEY)
	let activityDone = true
	if (!resuming || activityState) {
		const pass = await sweepActivityDetails(volume, activityStore, activityState, now).catch(
			() => undefined
		)
		if (pass?.done === false) {
			await state.put(ACTIVITY_SWEEP_KEY, pass.state)
			activityDone = false
		} else if (pass?.done && activityState) await state.delete(ACTIVITY_SWEEP_KEY)
	}
	// A failed (or absent) sweep reports nothing: it retries on the next daily alarm,
	// and a backend that cannot sweep has nothing to come back for.
	const swept = await Promise.all(stores.map((store) => store.gc?.().catch(() => undefined)))
	if (!activityDone || swept.some((pass) => pass?.done === false)) {
		// Alarm first, marker second: a failed re-arm must not leave a marker behind
		// that would silently skip the next day's agent maintenance.
		await state.setAlarm(now + SWEEP_RESUME_DELAY_MS)
		await state.put(SWEEP_RESUME_KEY, true)
	} else if (resuming) await state.delete(SWEEP_RESUME_KEY)
	return { daily: !resuming }
}

/**
 * Walk the local detail cache a few pages at a time. The first pass drops old
 * files. The second counts bytes and keeps a fixed-size set of the oldest files
 * to remove; it repeats that pass until the cache fits.
 */
export async function sweepActivityDetails(
	volume: Volume,
	store: Store,
	resume?: ActivitySweep,
	now = Date.now(),
	limits: ActivityDetailLimits = {
		ttlMs: ACTIVITY_DETAIL_TTL_MS,
		storeLimit: ACTIVITY_DETAIL_STORE_LIMIT
	}
): Promise<{ done: true } | { done: false; state: ActivitySweep }> {
	const root = await activityRoot(store)
	if (!root) return { done: true }
	const workLimit = Math.max(1, limits.workLimit ?? ACTIVITY_SWEEP_WORK_LIMIT)
	const evictBatch = Math.max(1, limits.evictBatch ?? ACTIVITY_SWEEP_EVICT_BATCH)
	const limit = BigInt(limits.storeLimit)
	const state: ActivitySweep = resume ?? {
		phase: 'age',
		cutoffNs: (BigInt(now - limits.ttlMs) * 1_000_000n).toString(),
		stack: [{ id: root.id, path: ACTIVITY_DETAIL_ROOT }],
		total: '0',
		oldest: []
	}
	let work = 0

	while (work < workLimit) {
		const dir = state.stack.at(-1)
		if (!dir) {
			if (state.phase === 'age') {
				state.phase = 'limit'
				state.stack = [{ id: root.id, path: ACTIVITY_DETAIL_ROOT }]
				state.total = '0'
				continue
			}

			let total = BigInt(state.total)
			state.oldest.sort(compareActivityFiles)
			for (const detail of state.oldest) {
				if (total <= limit) break
				try {
					await volume.rm(detail.path)
					total -= BigInt(detail.size)
				} catch {}
			}
			if (total <= limit) return { done: true }
			state.stack = [{ id: root.id, path: ACTIVITY_DETAIL_ROOT }]
			state.total = '0'
			state.oldest = []
			continue
		}

		const page = await store.children(dir.id, dir.cursor)
		if (page.next === undefined) state.stack.pop()
		else dir.cursor = page.next
		const children: ActivitySweep['stack'] = []
		for (const node of page.nodes) {
			work++
			const path = `${dir.path}/${node.name}`
			if (node.type === 'dir') {
				children.push({ id: node.id, path })
				continue
			}
			if (node.type !== 'file') continue

			if (state.phase === 'age') {
				if (node.mtimeNs >= BigInt(state.cutoffNs)) continue
				try {
					await volume.rm(path)
				} catch {}
				continue
			}

			state.total = (BigInt(state.total) + node.size).toString()
			state.oldest.push({
				path,
				size: node.size.toString(),
				mtimeNs: node.mtimeNs.toString()
			})
			state.oldest.sort(compareActivityFiles)
			if (state.oldest.length > evictBatch) state.oldest.pop()
		}
		state.stack.push(...children.reverse())
	}

	return { done: false, state }
}

async function activityRoot(store: Store) {
	const cache = await store.child(ROOT, 'cache')
	if (cache?.type !== 'dir') return null
	const root = await store.child(cache.id, 'agent-activity')
	return root?.type === 'dir' ? root : null
}

function compareActivityFiles(left: ActivityFile, right: ActivityFile): number {
	const leftTime = BigInt(left.mtimeNs)
	const rightTime = BigInt(right.mtimeNs)
	if (leftTime === rightTime) return left.path.localeCompare(right.path)
	return leftTime < rightTime ? -1 : 1
}

// NO AVATAR SWEEP. Derived faces live in `<avatar>/.gen/<hash of resting>/`, so replacing an
// avatar's resting file orphans one DIRECTORY — and the generator takes the siblings out
// before it writes the current one (src/agent/faces.ts). Stale art is collected by the next
// generation instead of by a scheduled job, which is what the authored/derived split buys:
// worst case one orphan directory sits until the next expression tag, against a daily task
// and a filename grammar we no longer have to parse. Installed avatars are NEVER pruned —
// a pack, or the user's own photo, is their property.
