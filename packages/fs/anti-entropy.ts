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
 * Scope (v1): reconciles PUT divergence (differing content + missing puts).
 * `pathScan` carries no tombstones, so DELETE propagation stays the delta path's
 * job — but a delete is never *undone* here (the apply-side version guard rejects
 * a stale resurrection).
 */

import { incomingWins } from './storage.shared'
import { PAGE, type SyncReplica, uploadBlobs } from './sync-replica'
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
		if (await agree(l, r)) continue
		// `incomingWins(x, y)` = does x beat y? A missing side always loses.
		if (r && (!l || (await incomingWins(r, l)))) toPull.push(r)
		else if (l) toPush.push(l)
	}

	// Pull first (lazy-friendly: applyPathChanges installs a stub, no blob fetch).
	// The apply re-guards with incomingWins vs the live local state, so a race can
	// never let a loser through. Drop remote winners whose content is missing on
	// BOTH sides: an EAGER local apply fetches each winner's blob via getBlobByHash,
	// so one orphaned reference would throw `ENOENT: blob` and abort the pass BEFORE
	// the push (pull runs first). Symmetric with push's uploadBlobs; here the
	// transfer stays applyPathChanges' job (eager fetch / lazy stub), so we only
	// detect — the lazy path still moves zero bytes.
	let pulled = 0
	if (toPull.length) {
		const applicable: PathChange[] = []
		for (const c of toPull) {
			const orphaned =
				c.kind === 'put' &&
				!!c.contentHash &&
				!(await local.hasBlobByHash(c.contentHash)) &&
				!(await remote.hasBlobByHash(c.contentHash))
			if (!orphaned) applicable.push(c)
		}
		if (applicable.length)
			await local.applyPathChanges(applicable, (h) => remote.getBlobByHash(h), { source })
		pulled = applicable.length
	}

	// Push: content up first (only hashes the remote lacks), then apply on the
	// remote, which re-guards the same way (and rejects resurrecting a delete). An
	// orphaned put (content missing on both sides) is dropped, never thrown, so one
	// dead reference can't abort the reconcile.
	let pushed = 0
	if (toPush.length) {
		const orphaned = await uploadBlobs(toPush, local, remote)
		const applicable = orphaned.length ? toPush.filter((c) => !orphaned.includes(c)) : toPush
		if (applicable.length)
			await remote.applyPathChanges(applicable, (h) => remote.getBlobByHash(h), { source })
		pushed = applicable.length
	}

	return {
		localPaths: localManifest.size,
		remotePaths: remoteManifest.size,
		pulled,
		pushed
	}
}
