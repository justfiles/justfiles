/**
 * A volume that runs its own sync: the surface an app holds.
 *
 * Everything underneath already exists and neither half of it RUNS anything —
 * `storeVolume` answers calls, `sync` returns when its cycle is done. This is
 * what makes them a live replica, and it is deliberately thin: a timer, a
 * debounce, a status, and the two resets.
 *
 * - **The loop.** One cycle on an interval, one behind a burst of local writes
 *   (debounced), and one whenever a caller asks (`flush`). A cycle is the
 *   engine's, whole: this file never pushes or pulls anything itself.
 * - **The trigger reads the row's author.** A committed write arms a push only
 *   if THIS replica wrote it. There is no origin tag to consult and no state
 *   file to skip, because a cursor lives in the host's slot and a version
 *   carries its author — the two pieces of bookkeeping the old engine kept
 *   inside the user's tree.
 * - **The two resets** are the only things here that rewrite a whole store, and
 *   they are asymmetric because the stores are: this replica's own is its to
 *   rewrite row by row, so `takeTheirs` tombstones it and moves the cursors that
 *   decide what is offered from it; the authority is somebody else's, so
 *   `takeMine` asks it to start a new lineage (the injected `reset`), re-authors
 *   what this replica did not write — which is what makes the whole tree its to
 *   publish — and offers the feed again from the top.
 *
 *   Both then loop until a scan finds nothing left to do, because standing the
 *   loop off does not stand the app off: a row that lands after the last pass
 *   would be stranded on this device by the very cursor the reset saves.
 *
 * T18 renames this to `synced`.
 */

import { authorOf, type CursorSlot, hydratingBlobs, sync, versions } from './engine'
import { type Cursor, type Guard, GuardError, type Node, ROOT, type Store } from './store'
import type { Volume } from './volume'
import { type Bindings, storeVolume } from './volume.store'

/** A host that keeps a cursor for this wrapper needs its type, and nothing else of the engine's. */
export type { CursorSlot } from './engine'

/** How often the loop runs when nothing has asked it to run sooner. */
const INTERVAL_MS = 30_000

/** After a failed cycle, in order. The last one repeats. */
const RETRY_MS = [5_000, 15_000, 60_000]

/** Fold a burst of local writes into one push after this much quiet... */
const DEBOUNCE_MS = 3_000

/** ...but never hold one back longer than this, however busy the writer is. */
const MAX_WAIT_MS = 15_000

/** How many times a whole-store rewrite replans before it gives up. */
const MAX_ATTEMPTS = 8

/**
 * What the loop is doing. Network and auth states (offline, signed out) are the
 * app's to layer on top: it holds those signals, and this holds none of them.
 */
export type SyncStatus = 'connecting' | 'syncing' | 'synced' | 'error'

/**
 * Where a replica keeps the one bit that says a DISCARD stopped half-done. The
 * host owns the storage, for the reason it owns the two cursors: this is engine
 * state, so it may not live in the replicated table nor in the user's tree.
 *
 * It has to be durable because the two halves of `takeTheirs` cannot be one step
 * — the cutoff is only knowable AFTER the tombstones are committed, so a crash
 * in between leaves a store whose rows say "delete everywhere" sitting past a
 * push cursor that never moved. A wrapper built over a raised flag finishes the
 * discard before its first cycle; without a slot, the flag is in memory and that
 * crash is unrecoverable.
 */
export type DiscardSlot = {
	load(): Promise<boolean>
	save(unfinished: boolean): Promise<void>
}

export type SyncedProps = {
	/** This replica's own store: the working copy, and what the volume reads. */
	local: Store
	/** The peer. A `Store`, so a folder, a server and another replica all fit. */
	remote: Store
	/**
	 * The host's fstab: which of ITS OWN stores stands at which name (`volume.store.ts`).
	 * Only the local store is synced — a bound store is joined at a name and is nobody
	 * else's business — so this is here rather than anywhere near the engine: the volume
	 * is what crosses a mount, and the volume is what this builds.
	 */
	bindings?: Bindings
	/**
	 * This replica's id: the author tag inside every version it mints, which is
	 * what keeps the push echo-free. It must be STABLE across restarts, and it is
	 * the host's to keep — a durable slot for it is the same problem as a durable
	 * slot for a cursor, which the host has already solved.
	 */
	replica: string
	/** Where this replica keeps its position in the peer's feed. */
	pull: CursorSlot
	/** Where it keeps its position in its own. */
	push: CursorSlot
	/**
	 * Where it keeps "a discard stopped half-done". An app without one keeps that
	 * bit in memory and cannot recover the crash the type above describes — which is
	 * a test's business, not an app's.
	 */
	discard?: DiscardSlot
	/** How often the loop runs by itself. Default 30s. */
	interval?: number
	/**
	 * Take the peer's rows without its bytes. Two things together, and one
	 * without the other is a broken replica: the pull stops fetching, and the
	 * volume reads through `hydratingBlobs` so a read of a stub fetches what it
	 * needs. The second half is unconditional here (see below), so this option
	 * is only the first.
	 */
	lazyContent?: boolean
	/**
	 * Hand the volume over before the first cycle instead of after it. The local
	 * store IS the working copy, so a local-first app is answering calls while
	 * the first cycle is still running; the default waits, so the first read
	 * already sees what the peer holds.
	 */
	localFirst?: boolean
	/**
	 * Start a new lineage on the authority: the one step of `takeMine` that no
	 * `Store` method can express, because the authority is not this replica's to
	 * rewrite. In the app it is the generation CAS in `packages/core/src/reset.ts`
	 * (`mode: 'adopt-mine'`), which truncates the tree and keeps the content — so
	 * a lazy replica's re-authored stubs still have bytes behind them.
	 *
	 * The epoch it returns is the only thing this wrapper ever learns about one.
	 */
	reset?: () => Promise<number | undefined>
}

export type SyncLifecycle = {
	/** Run one cycle now, and resolve once writes made before this call are at the peer. */
	flush(): Promise<void>
	/** Stop the loop. It keeps the volume; nothing syncs until `resume`. */
	pause(): void
	/** Start it again, with a cycle straight away. */
	resume(): void
	/** Done. No timer, no trigger, and no cycle — not even for a later `flush`. */
	destroy(): void
	status(): SyncStatus
	onStatusChange(fn: (status: SyncStatus) => void): () => void
	/**
	 * "Take theirs": throw this replica's work away and take the peer's tree.
	 * Every live row becomes a tombstone, the push cursor moves past them so none
	 * of it is ever offered, and the pull starts the peer's feed from the top.
	 */
	takeTheirs(): Promise<void>
	/**
	 * "Take mine": publish THIS volume as the authority's new baseline. Other
	 * replicas converge as the ordinary loop drains it.
	 */
	takeMine(): Promise<void>
	/**
	 * The authority's lineage epoch as last reported here — by `reset` and by
	 * nothing else, since no part of the seam carries one: a lineage lives in the
	 * cursors, and rule 11 is what fences a replica that outlived one. It stays
	 * in this surface because the app's own factory reset CASes against an epoch,
	 * over a route that is the server's rather than this seam's.
	 */
	generation(): number | undefined
}

export async function syncedVolume(props: SyncedProps): Promise<Volume & SyncLifecycle> {
	const { local, remote, replica } = props
	const interval = props.interval ?? INTERVAL_MS
	const mint = versions(replica)
	const opts = { replica, pull: props.pull, push: props.push, lazyContent: props.lazyContent }

	// The volume reads through `hydratingBlobs` whether or not the pull is lazy.
	// A row naming content this replica does not hold is the same row either way
	// — an eager pull moves what the peer could produce WHEN the page landed, and
	// a peer that was a stub itself then can answer for it now — so the branch
	// would buy a second way to fail rather than a second behaviour.
	// The bindings are keyed on the store the volume is built over, which is the
	// WRAPPER — so they are read against `hydratingBlobs(local, remote)`, not against
	// `local`. Nothing else here knows the difference, and `storeVolume` compares
	// identity rather than looking inside.
	const vol = storeVolume(hydratingBlobs(local, remote), {
		bindings: props.bindings,
		mintVersion: mint
	})

	let epoch: number | undefined
	let status: SyncStatus = 'connecting'
	const watching = new Set<(status: SyncStatus) => void>()
	const setStatus = (next: SyncStatus): void => {
		if (status === next) return
		status = next
		for (const fn of watching) fn(next)
	}

	let running: Promise<void> | null = null
	let queued: Promise<void> | null = null
	let timer: ReturnType<typeof setTimeout> | undefined
	let pushTimer: ReturnType<typeof setTimeout> | undefined
	let armed: number | undefined
	let paused = false
	let destroyed = false
	let failures = 0
	/**
	 * A reset owns this wrapper: no other reset may start, and the loop may not
	 * act. Held from the entry guard through the converge cycle, so a reset is
	 * over — one way or the other — before the next one is allowed to begin.
	 */
	let resetting = false
	/**
	 * A DISCARD stopped half-done, and nothing but another discard can finish it.
	 * Durable, in a slot the host keeps beside the two cursors, because the two
	 * halves below cannot be made one step. The loop must not act in either half:
	 *
	 * - before the cutoff is saved, the tombstones sit past a push cursor that
	 *   has not moved, so one cycle offers them to the authority and turns "take
	 *   theirs" into "delete everywhere";
	 * - before the pull is rewound, the volume is empty and the peer's rows are
	 *   all behind the saved cursor, so no cycle brings them back and a running
	 *   loop would just look healthy over an empty tree.
	 *
	 * A failure therefore leaves this set and the loop stopped. Another
	 * `takeTheirs` is the recovery — it finds nothing left to tombstone and
	 * finishes the cursors its first run could not — which is why `takeMine` must
	 * refuse to start here: it would truncate the authority and then be unable to
	 * publish anything to it. The recovery runs by itself for the crash case: a
	 * wrapper built over a raised flag finishes the discard before its first cycle.
	 */
	let unfinished = false

	/** Raise or lower the flag, durably first: a bit only this process knows fences nothing. */
	const discarding = async (on: boolean): Promise<void> => {
		await props.discard?.save(on)
		unfinished = on
	}

	/** May the loop act? Every way it must not, in one place. */
	const mayRun = (): boolean => !paused && !destroyed && !resetting && !unfinished

	/** What a thrown thing says, for an error that carries another one's words. */
	const message = (thrown: unknown): string =>
		thrown instanceof Error ? thrown.message : String(thrown)

	function schedule(): void {
		if (!mayRun()) return
		const backoff = RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)]
		timer = setTimeout(run, failures > 0 && backoff !== undefined ? backoff : interval)
	}

	/**
	 * One cycle, and the status it reports. Its failure is thrown, and who
	 * catches it is the whole difference between the two callers: the loop's own
	 * cycles have nobody waiting on them, so `status` is the report and the next
	 * timer is the retry; a reset's converge cycle has a caller who is about to
	 * act on the answer, so it gets the error.
	 */
	async function cycle(): Promise<void> {
		cancelPush()
		setStatus('syncing')
		try {
			await sync(local, remote, opts)
			failures = 0
			setStatus('synced')
		} catch (error) {
			console.error(error)
			failures++
			setStatus('error')
			throw error
		}
	}

	function run(): void {
		if (running || !mayRun()) return
		running = cycle()
			.catch(() => undefined) // said by `status`; there is nobody else to tell
			.finally(() => {
				running = null
				schedule()
			})
	}

	/**
	 * Run a cycle now and resolve when writes made BEFORE this call have reached
	 * the peer. A cycle already in flight may predate them, so a caller waits for
	 * that one and then gets another; concurrent callers share the follow-up.
	 */
	function flush(): Promise<void> {
		cancelPush()
		if (running) {
			queued ??= running.then(() => {
				queued = null
				return flush()
			})
			return queued
		}
		clearTimeout(timer)
		timer = undefined
		run()
		return running ?? Promise.resolve()
	}

	function pause(): void {
		paused = true
		clearTimeout(timer)
		timer = undefined
	}

	function resume(): void {
		paused = false
		run()
	}

	function destroy(): void {
		destroyed = true
		stop?.()
		cancelPush()
		clearTimeout(timer)
		timer = undefined
	}

	function cancelPush(): void {
		clearTimeout(pushTimer)
		pushTimer = undefined
		armed = undefined
	}

	/** Fold a burst of local writes into one push behind it. */
	function armPush(): void {
		if (!mayRun()) return
		const now = Date.now()
		armed ??= now
		clearTimeout(pushTimer)
		pushTimer = setTimeout(
			() => {
				cancelPush()
				void flush().catch(() => undefined)
			},
			Math.min(DEBOUNCE_MS, MAX_WAIT_MS - (now - armed))
		)
	}

	/**
	 * Run a reset with the loop standing off, and start it again afterwards.
	 *
	 * A reset writes rows and THEN moves the cursors that decide what is offered
	 * from them, and a cycle running between the two would push exactly what the
	 * user asked to throw away. `resetting` is this wrapper's own flag rather
	 * than the app's `paused`, so a reset neither reads nor writes a decision the
	 * app made — nothing here locks a store.
	 *
	 * The state is checked TWICE, and the second time is the one that is easy to
	 * miss: waiting for the cycle in flight is a window in which the app can
	 * pause or tear this replica down, and a reset that went ahead anyway would
	 * tombstone the tree — or truncate the authority — with no loop left to
	 * converge it. A reset is destroy-then-converge, so with the loop stopped it
	 * must not start.
	 */
	async function alone<T>(what: string, body: () => Promise<T>): Promise<T> {
		// One at a time. Two destructive bodies running over one store interleave
		// their passes and their flags — whichever finished first would clear the
		// fence and start syncing while the other was still tombstoning — and the
		// app that offers both offers them from a menu with no in-flight gate.
		if (resetting) throw new Error(`${what} cannot start: a reset is already running`)
		if (paused || destroyed) throw new Error(`${what} needs a running sync loop`)
		resetting = true
		clearTimeout(timer)
		timer = undefined
		try {
			await running // an in-flight cycle finishes; it never rejects
			if (paused || destroyed) throw new Error(`${what} needs a running sync loop`)
			const done = await body()
			// Nothing here can hold a teardown off — the app tears the STORE down
			// behind us — so a reset the loop was stopped under says so rather than
			// resolving. It still recovers: a pause converges on `resume`, a destroy
			// on the next replica over this store, since the cursors are saved by now.
			if (paused || destroyed)
				throw new Error(`${what} did not converge: the sync loop stopped while it ran`)
			// The converge half. It is the reset's OWN cycle rather than the loop's,
			// which settles two things at once: a reset is done when its work has
			// reached the peer, so this failure belongs to the caller and not to
			// `status`; and ownership can be held right through it, so a second reset
			// cannot slip in while this one is still converging and leave it reporting
			// a failure that was only the other one taking the flag.
			try {
				await cycle()
			} catch (error) {
				throw new Error(`${what} did not converge: ${message(error)}`, { cause: error })
			}
			return done
		} catch (error) {
			// The fence is still up, so the loop stays stopped and only another discard
			// can start it again. The status has to say that, whatever the last cycle
			// said: a caller would otherwise read the state from BEFORE the reset —
			// `synced` over a replica that will never sync again, or `connecting` for
			// ever on the one that inherited the flag at startup and could not clear it.
			if (unfinished) setStatus('error')
			throw error
		} finally {
			resetting = false
			// A reset that THREW never reaches the cycle that would put a timer back,
			// so a volume the user only tried to publish would quietly stop syncing.
			// `schedule` still answers for the ways it must NOT come back.
			schedule()
		}
	}

	/** The guard that says "nobody wrote this row after I read it". */
	const unchanged = (row: Node): Guard => ({ version: { id: row.id, is: row.version } })

	/** One scan of this replica's own feed: every row it holds, and where it ends. */
	async function feed(): Promise<{ rows: Node[]; tip: Cursor | undefined }> {
		const rows: Node[] = []
		let tip: Cursor | undefined
		for (;;) {
			const page = await local.since(tip)
			rows.push(...page.nodes)
			if (page.next === undefined) return { rows, tip }
			tip = page.next
			if (page.nodes.length === 0) return { rows, tip }
		}
	}

	/**
	 * What a reset touches. Tombstones and the root are left out: the root is a
	 * constant on every store (rule 6) and so is news to nobody, and a tombstone
	 * says nothing an authority that never held the row could use.
	 */
	const living = (rows: Node[]): Node[] => rows.filter((row) => !row.deleted && row.id !== ROOT)

	/**
	 * Whole-row rewrite of what a scan read, guarded on the state it read.
	 *
	 * Guarded, because the scan and the commit are two steps and a write between
	 * them would otherwise be overwritten by the state the scan happened to find;
	 * a refusal is not a failure here, it is the signal to read the rows again.
	 * One commit is also one batch, and a volume large enough to strain a
	 * backend's transaction would have to page it — a trade that waits for a
	 * measurement, since neither reset is on a hot path.
	 */
	const rewrite = (rows: Node[], next: (row: Node) => Node): Promise<void> =>
		local.commit(rows.map(next), rows.map(unchanged))

	async function takeTheirs(): Promise<void> {
		await alone('take theirs', async () => {
			// The tree the user asked to discard, gone from the volume first — and
			// then never offered. These tombstones are this replica's own rows, so an
			// ordinary push would carry them to the peer and take the volume down on
			// every other replica; moving the push cursor past them is what makes
			// this "discard mine" instead of "delete everywhere". It takes whatever
			// else was waiting to be pushed with it, which is the same decision.
			//
			// The tombstones and the two cursors are one step or they are nothing, and
			// only the flag can say so: a discard that stops in between leaves either
			// a tree the next cycle would delete everywhere, or an empty one no cycle
			// would refill. It is raised DURABLY before the first tombstone, so the
			// crash in between is recoverable rather than merely fenced.
			await discarding(true)
			// Tombstone until nothing live is left, and take the cutoff from the scan
			// that PROVES it. Two things make the passes necessary, and each leaves a
			// row that would sit past the cutoff — alive, never offered, and
			// device-only for good. One is arrival: `alone` stops this wrapper's loop,
			// not the app, so a row can land while a batch is committing. The other is
			// return: only the authority refuses to resurrect a tombstone (rule 9), so
			// a writer that reaches this store directly can put one back. Asking the
			// rows what they ARE, rather than remembering which ones were handled,
			// answers both.
			for (let left = MAX_ATTEMPTS; ; left--) {
				const scan = await feed()
				const live = living(scan.rows)
				if (live.length === 0) {
					await props.push.save(scan.tip)
					break
				}
				if (left === 0) throw new Error('take theirs cannot keep up with the writes under it')
				try {
					await rewrite(live, (row) => ({ ...row, deleted: true, version: mint() }))
				} catch (e) {
					// Somebody wrote one of these rows in between: read them again.
					if (!(e instanceof GuardError)) throw e
				}
			}
			// The peer's feed from the top: its rows land back over the tombstones,
			// and what only ever existed here stays dead. This is inside the flag
			// too — the peer's rows are all BEHIND the cursor this replaces, so a
			// loop left running over a store that lost this step would never bring
			// one of them back, and would look perfectly healthy doing it.
			await props.pull.save(undefined)
			await discarding(false)
		})
	}

	/**
	 * Interrupted anywhere, this leaves an emptied authority and a volume that is
	 * still whole here — so running it again is both the retry and the recovery,
	 * and it needs no durable "publishing" marker of the kind the old engine kept.
	 * Nothing is lost in that window: what the reset truncated is exactly what
	 * this replica still holds.
	 */
	async function takeMine(): Promise<void> {
		const reset = props.reset
		if (!reset) throw new Error('take mine needs a peer that can start a new lineage')
		// A half-done discard is the one state this must not start from: the tree
		// here is tombstoned, so the authority would be truncated and then handed
		// nothing — the volume gone from both sides, on two menu clicks.
		if (unfinished)
			throw new Error('take mine cannot start: a discard did not finish, so run take theirs again')
		await alone('take mine', async () => {
			epoch = await reset()
			// A replica pushes what it AUTHORED, not what it holds, so the emptied
			// authority would otherwise get back only the part of the volume this
			// replica happened to write — and the rest would sit here for ever, held
			// by a replica that never offers it. Re-authoring what came from
			// elsewhere is what makes the whole tree this replica's to publish.
			//
			// Until a scan finds nothing foreign, for the reason the discard loops:
			// this wrapper's loop is stood off, the app's writers are not, and a row
			// that arrived after the last pass is filtered out of every push from here
			// on. A row already ours needs no rewrite, which is what ends the walk.
			//
			// The last scan is the last word this reset has, and a row landing after
			// it is not this replica's to publish — T8's standing rule, which the
			// reset hands back to at SOME instant. No choice of instant makes it
			// never: the cursor lives in a host slot, outside the store, so nothing
			// can make "nothing foreign here" and "cursor rewound" one step, and
			// another pass would only move the window. It costs such a row a wait
			// rather than its life — it stays visible here, and the first write that
			// touches it re-authors it into the next push.
			for (let left = MAX_ATTEMPTS; ; left--) {
				const theirs = living((await feed()).rows).filter(
					(row) => authorOf(row.version) !== replica
				)
				if (theirs.length === 0) break
				if (left === 0) throw new Error('take mine cannot keep up with the writes under it')
				try {
					await rewrite(theirs, (row) => ({ ...row, version: mint() }))
				} catch (e) {
					// Somebody wrote one of these rows in between: read them again.
					if (!(e instanceof GuardError)) throw e
				}
			}
			// Offer the whole feed again, not just what changed since the last push.
			// The authority is empty, so "already sent" is true of nothing — and a
			// reset keeps the store's lineage (`packages/core/src/reset.ts`), so
			// nothing fences this cursor into rewinding by itself. A failure here
			// costs a partial republish that another `takeMine` completes; it cannot
			// delete anything, which is why this one needs no fence.
			await props.push.save(undefined)
		})
	}

	// A committed local write arms that push. Only this replica's own writes:
	// a pulled row is authored by the peer, and answering it with a push would
	// spend a cycle offering that peer its own rows back, for ever. There is
	// nothing else to filter out — this engine writes no state into the store.
	const stop = local.subscribe?.((rows) => {
		if (rows.some((row) => authorOf(row.version) === replica)) armPush()
	})

	// A discard the last process could not finish, finished before anything else
	// runs. Its own failure is not raised here: the flag stays up and the loop stays
	// stopped, which is what a failed discard leaves anyway — so the app gets its
	// volume, reads `error` from the status, and can ask again. Rejecting would leave
	// it with no volume at all and the same store to recover from.
	if (await props.discard?.load()) {
		unfinished = true
		await takeTheirs().catch((error) => console.error(error))
	}

	// The first cycle is armed the same way every other one is, so `connecting`
	// is a state a caller can actually observe: with `localFirst` the volume is
	// handed over before it runs, and without it the caller waits for it here.
	if (props.localFirst) timer = setTimeout(run, 0)
	else await flush()

	return {
		...vol,
		flush,
		pause,
		resume,
		destroy,
		status: () => status,
		onStatusChange(fn) {
			watching.add(fn)
			return () => watching.delete(fn)
		},
		takeTheirs,
		takeMine,
		generation: () => epoch
	}
}
