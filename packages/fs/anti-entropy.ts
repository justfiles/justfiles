/**
 * Anti-entropy: a periodic, path-keyed reconcile that GUARANTEES convergence even
 * when the delta cursors miss a change (a dropped delta, a cursor rewound by a
 * server swap, two dev servers that both start at generation 1, …). The delta
 * push/pull in `synced()` is the fast path; this is the correctness backstop.
 *
 * It is deliberately SELF-CONTAINED and side-effect-free at import time: it
 * touches only the `SyncReplica` seams (`pathScan`, `applyPathChanges`, the blob
 * store) and the shared LWW rule (`incomingWins`). `synced()` calls it behind a
 * flag, so the whole feature can be turned off in one place while debugging.
 *
 * Cost model (why it stays lightweight):
 *   - Metadata only: `pathScan` yields the per-path metadata (version, mode,
 *     mtime, xattrs, symlink target, contentHash), never blob bytes.
 *   - Skip-on-agree: a path whose (kind, version, durable state) match on both
 *     sides is skipped — no work, no transfer. In steady state (converged) the
 *     whole pass is two metadata scans and zero applies/blobs.
 *   - Content moves ONLY for genuinely divergent puts the target lacks (blobs are
 *     hash-addressed, so identical content never transfers).
 * `synced()` rate-limits it (every N cycles), so the O(paths) scan is amortised.
 *
 * Convergence: `applyPathChanges` re-checks `incomingWins` against the CURRENT
 * local state on EACH side, so the winner is the same on both replicas (higher
 * version, then a source-independent digest tie-break) — they converge, never
 * swap. Tombstones are enforced by that same guard, so a live put can never
 * resurrect a higher-versioned delete.
 *
 * Scope: reconciles BOTH put divergence (differing content + missing puts) AND
 * missed deletes. The manifest scan is requested with `tombstones: true`, so a
 * cursor-missed delete on one side propagates to the other (its higher-versioned
 * tombstone beats a stale live put via the same LWW rule); a converged tombstone
 * matches on both sides and is skipped. `applyPathChanges` re-guards, so a stale
 * live put can never resurrect a higher-versioned delete.
 */

import { incomingWins } from './storage.shared'
import { mirrorBlobs, PAGE, type SyncReplica, uploadBlobs } from './sync-replica'
import { changeDigest, type PathChange } from './sync-wire'

/** What one reconcile pass did — returned for observability + tests. */
export interface ReconcileResult {
	/** Live paths seen in each replica's snapshot. */
	localPaths: number
	remotePaths: number
	/** Remote winners applied locally (pull direction). */
	pulled: number
	/** Local winners applied to the remote (push direction). */
	pushed: number
	/**
	 * The server lineage epoch observed while scanning the remote (client<->server
	 * only; undefined for P2P). `synced()` runs its mid-session reset check on it, so
	 * a lineage that advanced mid-scan can't be silently reported as converged.
	 */
	generation?: number
}

export interface ReconcileOptions {
	/** Page size for `pathScan` (defaults to the shared `PAGE`). */
	limit?: number
	/**
	 * Local-apply tag stamped on everything this pass writes (matches `synced()`'s
	 * pull/push so the writes are echo-suppressed and `volume.watch` sees them as
	 * remote-sourced). Defaults to `'remote'`.
	 */
	source?: string
}

// Two changes are converged only when kind + version match AND their whole
// durable state does — the same `changeDigest` incomingWins tie-breaks on.
// Comparing contentHash alone would call meta-only drift (mode / xattr / symlink
// target — and ALL dir & symlink divergence, whose contentHash is always
// undefined) "converged", so the digest tie-break would never run and the
// metadata would stay split forever. Version differs => cheap reject, no hashing.
async function agree(a: PathChange | undefined, b: PathChange | undefined): Promise<boolean> {
	if (!a || !b || a.kind !== b.kind || a.version !== b.version) return false
	return (await changeDigest(a)) === (await changeDigest(b))
}

/** Page a replica's full snapshot into a path -> latest-change map (puts + tombstones). */
async function manifest(
	replica: SyncReplica,
	limit: number
): Promise<{ paths: Map<string, PathChange>; generation?: number }> {
	const paths = new Map<string, PathChange>()
	let generation: number | undefined
	let page: string | undefined
	do {
		// `tombstones: true` so a cursor-missed delete converges too (not just puts).
		const res = await replica.pathScan(page, { limit, tombstones: true })
		for (const c of res.changes) paths.set(c.path, c)
		// Client<->server pages echo the live generation; carry the last seen so a reset
		// that lands mid-scan is surfaced to `synced()`. P2P leaves it undefined.
		if (res.generation !== undefined) generation = res.generation
		page = res.done ? undefined : res.next
	} while (page)
	return { paths, generation }
}

/**
 * One anti-entropy pass between `local` and `remote`. Exchanges manifests, and for
 * every path where they disagree feeds the deterministic winner to the losing
 * side. Idempotent: a converged pair yields `{ pulled: 0, pushed: 0 }` and moves
 * no bytes.
 */
export async function reconcile(
	local: SyncReplica,
	remote: SyncReplica,
	options: ReconcileOptions = {}
): Promise<ReconcileResult> {
	const limit = options.limit ?? PAGE
	const source = options.source ?? 'remote'
	const [localScan, remoteScan] = await Promise.all([
		manifest(local, limit),
		manifest(remote, limit)
	])
	const localManifest = localScan.paths
	const remoteManifest = remoteScan.paths

	const toPull: PathChange[] = [] // remote winners -> apply locally
	const toPush: PathChange[] = [] // local winners -> apply on the remote
	const paths = new Set<string>([...localManifest.keys(), ...remoteManifest.keys()])
	for (const path of paths) {
		const l = localManifest.get(path)
		const r = remoteManifest.get(path)
		if (await agree(l, r)) continue
		// `incomingWins(x, y)` = does x beat y? A missing side always loses.
		if (r && (!l || (await incomingWins(r, l)))) toPull.push(r)
		else if (l) toPush.push(l)
	}

	// Pull: ensure the remote actually HOLDS each winner's blob before applying it
	// locally — repairing the remote from our local copy when it lost a hash we still
	// have (recoverable: content is hash-addressed, so the local bytes ARE the
	// winner's bytes). A truly orphaned ref (missing on BOTH sides) is dropped, not
	// thrown, so one dead reference can't make the eager local apply throw `ENOENT:
	// blob` and abort the pass BEFORE the push (pull runs first). Symmetric with the
	// push direction below; the common case (remote already has the blob) moves zero
	// bytes, so the lazy path stays fetch-free. The apply re-guards with incomingWins
	// vs the live local state, so a race can never let a loser through.
	let pulled = 0
	if (toPull.length) {
		const orphaned = await uploadBlobs(toPull, local, remote)
		const applicable = orphaned.length ? toPull.filter((c) => !orphaned.includes(c)) : toPull
		if (applicable.length)
			await local.applyPathChanges(applicable, (h) => remote.getBlobByHash(h), { source })
		pulled = applicable.length
	}

	// Push: ensure BOTH sides hold each winner's blob before the remote apply —
	// `mirrorBlobs` sends any hash the remote lacks up AND repairs the local source
	// from the remote when local lost a hash the remote still holds (recoverable:
	// content is hash-addressed), so eager local reads keep working after the
	// manifests agree. Symmetric with the pull-side repair above. A truly orphaned
	// put (missing on BOTH sides) is dropped, never thrown, so one dead reference
	// can't abort the reconcile; the remote apply re-guards with incomingWins (and
	// rejects resurrecting a delete).
	let pushed = 0
	if (toPush.length) {
		const orphaned = await mirrorBlobs(toPush, local, remote)
		const applicable = orphaned.length ? toPush.filter((c) => !orphaned.includes(c)) : toPush
		if (applicable.length)
			await remote.applyPathChanges(applicable, (h) => remote.getBlobByHash(h), { source })
		pushed = applicable.length
	}

	return {
		localPaths: localManifest.size,
		remotePaths: remoteManifest.size,
		pulled,
		pushed,
		generation: remoteScan.generation
	}
}
