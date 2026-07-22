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
 *   - Metadata only: `pathScan` yields `{path, version, contentHash}` per path,
 *     never blob bytes.
 *   - Skip-on-agree: a path whose (kind, version, contentHash) match on both
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
 * Scope (v1): reconciles PUT divergence (differing content + missing puts).
 * `pathScan` carries no tombstones, so DELETE propagation stays the delta path's
 * job — but a delete is never *undone* here (the apply-side version guard rejects
 * a stale resurrection).
 */

import { incomingWins } from './storage.shared'
import { PAGE, type SyncReplica, uploadBlobs } from './sync-replica'
import type { PathChange } from './sync-wire'

/** What one reconcile pass did — returned for observability + tests. */
export interface ReconcileResult {
	/** Live paths seen in each replica's snapshot. */
	localPaths: number
	remotePaths: number
	/** Remote winners applied locally (pull direction). */
	pulled: number
	/** Local winners applied to the remote (push direction). */
	pushed: number
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

// Two live puts converge already when kind + version + contentHash match. Meta-
// only drift at an identical (version, contentHash) is cosmetic and intentionally
// skipped to keep the pass cheap; any real mutation bumps the version.
function agree(a: PathChange | undefined, b: PathChange | undefined): boolean {
	if (!a || !b || a.kind !== b.kind || a.version !== b.version) return false
	if (a.kind === 'put' && b.kind === 'put') return a.contentHash === b.contentHash
	return true
}

/** Page a replica's full snapshot into a path -> latest-put map (metadata only). */
async function manifest(replica: SyncReplica, limit: number): Promise<Map<string, PathChange>> {
	const out = new Map<string, PathChange>()
	let page: string | undefined
	do {
		const res = await replica.pathScan(page, { limit })
		for (const c of res.changes) out.set(c.path, c)
		page = res.done ? undefined : res.next
	} while (page)
	return out
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
	const [localManifest, remoteManifest] = await Promise.all([
		manifest(local, limit),
		manifest(remote, limit)
	])

	const toPull: PathChange[] = [] // remote winners -> apply locally
	const toPush: PathChange[] = [] // local winners -> apply on the remote
	const paths = new Set<string>([...localManifest.keys(), ...remoteManifest.keys()])
	for (const path of paths) {
		const l = localManifest.get(path)
		const r = remoteManifest.get(path)
		if (agree(l, r)) continue
		// `incomingWins(x, y)` = does x beat y? A missing side always loses.
		if (r && (!l || (await incomingWins(r, l)))) toPull.push(r)
		else if (l) toPush.push(l)
	}

	// Pull first (lazy-friendly: applyPathChanges installs a stub, no blob fetch).
	// The apply re-guards with incomingWins vs the live local state, so a race can
	// never let a loser through.
	if (toPull.length)
		await local.applyPathChanges(toPull, (h) => remote.getBlobByHash(h), { source })

	// Push: content up first (only hashes the remote lacks), then apply on the
	// remote, which re-guards the same way (and rejects resurrecting a delete).
	if (toPush.length) {
		await uploadBlobs(toPush, local, remote)
		await remote.applyPathChanges(toPush, (h) => remote.getBlobByHash(h), { source })
	}

	return {
		localPaths: localManifest.size,
		remotePaths: remoteManifest.size,
		pulled: toPull.length,
		pushed: toPush.length
	}
}
