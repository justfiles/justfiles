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
 *   `takeMine` asks it to start a new lineage (the injected `reset`) and then
 *   re-authors every local row, which is what makes the whole tree this
 *   replica's to publish.
 *
 * T18 renames this to `synced`.
 */

import { authorOf, type CursorSlot, hydratingBlobs, sync, versions } from './engine'
import { type Cursor, GuardError, type Node, ROOT, type Store } from './store'
import type { Volume } from './volume'
import { storeVolume } from './volume.store'

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

export type SyncedProps = {
	/** This replica's own store: the working copy, and what the volume reads. */
	local: Store
	/** The peer. A `Store`, so a folder, a server and another replica all fit. */
	remote: Store
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
	const vol = storeVolume(hydratingBlobs(local, remote), { mintVersion: mint })

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

	function schedule(): void {
		if (paused || destroyed) return
		const backoff = RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)]
		timer = setTimeout(run, failures > 0 && backoff !== undefined ? backoff : interval)
	}

	function run(): void {
		if (running || paused || destroyed) return
		cancelPush()
		setStatus('syncing')
		running = sync(local, remote, opts)
			.then(() => {
				failures = 0
				setStatus('synced')
			})
			.catch((error: unknown) => {
				// The status says a cycle failed; only this says what failed, and a
				// background loop has nowhere else to say it.
				console.error(error)
				failures++
				setStatus('error')
			})
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
		if (paused || destroyed) return
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
	 * Run this with the loop stopped, and start it again afterwards.
	 *
	 * A reset writes rows and THEN moves the cursors that decide what is offered
	 * from them, and a cycle running between the two would push exactly what the
	 * user asked to throw away. Nothing here locks a store: it stops this
	 * wrapper's own loop, which is the only thing this wrapper starts.
	 */
	async function alone<T>(body: () => Promise<T>): Promise<T> {
		const was = paused
		pause()
		try {
			await running // an in-flight cycle finishes; it never rejects
			return await body()
		} finally {
			paused = was
			// The stop took the timer with it, and a reset that THREW never reaches
			// the flush that would put one back — so a volume the user only tried to
			// publish would quietly stop syncing.
			if (!paused) schedule()
		}
	}

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
	 * Rewrite every live row this replica holds, in ONE commit guarded on what
	 * the scan read.
	 *
	 * Atomic, because half a reset is worse than none: `takeMine` publishes a
	 * whole volume or no part of it. Guarded, because the scan and the commit are
	 * two steps and a local write between them would otherwise be overwritten by
	 * the state the scan happened to read — so a write that lands mid-rewrite
	 * rejects it, and it is read again rather than lost. Tombstones and the root
	 * are left out: the root is a constant on every store (rule 6) and so is news
	 * to nobody, and a tombstone says nothing an authority that never held the
	 * row could use.
	 *
	 * One commit means one batch, and a volume large enough to strain a backend's
	 * transaction would have to page it — at the cost of the atomicity above, and
	 * of a replan per page. Neither reset is on any hot path, so that trade waits
	 * for a measurement rather than an anticipation.
	 */
	async function rewrite(next: (row: Node) => Node): Promise<void> {
		for (let left = MAX_ATTEMPTS; ; left--) {
			const rows = (await feed()).rows.filter((row) => !row.deleted && row.id !== ROOT)
			if (rows.length === 0) return
			try {
				return await local.commit(
					rows.map(next),
					rows.map((row) => ({ version: { id: row.id, is: row.version } }))
				)
			} catch (e) {
				if (left === 0 || !(e instanceof GuardError)) throw e
			}
		}
	}

	async function takeTheirs(): Promise<void> {
		await alone(async () => {
			// The tree the user asked to discard, gone from the volume first.
			await rewrite((row) => ({ ...row, deleted: true, version: mint() }))
			// ...and never offered. These tombstones are this replica's own rows, so
			// an ordinary push would carry them to the peer and take the volume down
			// on every other replica — moving the push cursor past them is what makes
			// this "discard mine" instead of "delete everywhere". It takes whatever
			// else was waiting to be pushed with it, which is the same decision.
			await props.push.save((await feed()).tip)
			// The peer's feed from the top: its rows land back over the tombstones,
			// and what only ever existed here stays dead.
			await props.pull.save(undefined)
		})
		await flush()
	}

	/**
	 * Interrupted between the reset and the re-author, this leaves an empty
	 * authority and a volume that is still whole here — so running it again is
	 * both the retry and the recovery, and it needs no durable "publishing"
	 * marker of the kind the old engine kept. Nothing is lost in that window:
	 * what the reset truncated is exactly what this replica still holds.
	 */
	async function takeMine(): Promise<void> {
		const reset = props.reset
		if (!reset) throw new Error('take mine needs a peer that can start a new lineage')
		await alone(async () => {
			epoch = await reset()
			// A replica pushes what it AUTHORED, not what it holds, so without this
			// the emptied authority would get back only the part of the volume this
			// replica happened to write — and the rest would sit here for ever, held
			// by a replica that never offers it. Re-authoring is what makes the whole
			// tree this replica's to publish, and it is why the ordinary push carries
			// the republish: a written row moves to the end of the local feed
			// (rule 4), so the next scan finds all of it.
			await rewrite((row) => ({ ...row, version: mint() }))
		})
		await flush()
	}

	// A committed local write arms that push. Only this replica's own writes:
	// a pulled row is authored by the peer, and answering it with a push would
	// spend a cycle offering that peer its own rows back, for ever. There is
	// nothing else to filter out — this engine writes no state into the store.
	const stop = local.subscribe?.((rows) => {
		if (rows.some((row) => authorOf(row.version) === replica)) armPush()
	})

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
