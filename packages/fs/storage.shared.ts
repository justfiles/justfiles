/**
 * Pure path-sync rules shared by every owned backend (mem, SQLite/DO, IDB).
 *
 * These are the nuanced, bug-prone decisions — version generation, tombstone
 * fast-forward, the regular-file `contentHash` rule, wire construction, and the
 * child-before-parent / parent-before-child ordering — extracted as PURE
 * functions so they are written once, tested directly, and SHIP in every
 * backend (rather than living only in the `memStorage` test double).
 *
 * Deliberately NOT an abstraction: no port, no transaction interface. Each
 * backend keeps its own storage access + atomicity and CALLS these helpers. The
 * `pathOf(ino)` walk and subtree enumeration stay per-backend (they touch the
 * backend's own index/tables), because backends legitimately differ there (a
 * Map walk vs a set-based SQL query).
 */

import type { InodeMeta } from './storage'
import type { PathChange } from './sync-wire'
import { changeDigest, compareVersion, encodeVersion, syncMetaFromInode } from './sync-wire'
import { FileType } from './types'

// ── Path helpers ──────────────────────────────────────────────────────────────

/** Split a canonical absolute path into `{ parentPath, name }`. */
export function splitPath(p: string): { parentPath: string; name: string } {
	const idx = p.lastIndexOf('/')
	return { parentPath: idx === 0 ? '/' : p.slice(0, idx), name: p.slice(idx + 1) }
}

/** Join a canonical directory path and a child name into a child path. */
export function joinPath(dirPath: string, name: string): string {
	return dirPath === '/' ? `/${name}` : `${dirPath}/${name}`
}

/** Path depth (segment count); '/' is 0, '/a' is 1, '/a/b' is 2. */
export function pathDepth(p: string): number {
	return p === '/' ? 0 : p.slice(1).split('/').length
}

// ── Version generation ──────────────────────────────────────────────────────

/**
 * The next outgoing version for a local mutation at a path: one past the higher
 * of the current version and any tombstone, so a resurrected path never sorts
 * below its own tombstone. Fast-forward only.
 */
export function nextVersion(currentVersion: number, tombstoneVersion: number): number {
	return Math.max(currentVersion, tombstoneVersion) + 1
}

// ── PathChange construction (the wire shape + contentHash rule) ───────────────

/**
 * Build a `put` `PathChange` from a resolved inode's current state. Returns
 * `null` for a fresh regular file that has no content yet (no `contentHash`):
 * its put is journaled later by the content write, so there is nothing to
 * journal now. Encapsulates the schema invariant that a regular-file put carries
 * a `contentHash` while dirs/symlinks must not.
 */
export function buildPutChange(
	path: string,
	meta: InodeMeta,
	xattrs: Record<string, Uint8Array>,
	version: number,
	source: string
): PathChange | null {
	if (meta.type === FileType.Regular && !meta.contentHash) return null
	const base = { kind: 'put' as const, path, version: encodeVersion(version), source }
	const sm = syncMetaFromInode(meta, xattrs)
	return meta.type === FileType.Regular
		? { ...base, contentHash: meta.contentHash, meta: sm }
		: { ...base, meta: sm }
}

/** Build a `delete` `PathChange` (carries only kind + path + version + source). */
export function buildDeleteChange(path: string, version: number, source: string): PathChange {
	return { kind: 'delete', path, version: encodeVersion(version), source }
}

// ── Ordering (child-before-parent deletes, parent-before-child puts) ──────────

/** Order items deepest-path-first (child before parent) — for deletes. */
export function sortChildFirst<T>(items: T[], pathOf: (t: T) => string): T[] {
	return [...items].sort((a, b) => pathDepth(pathOf(b)) - pathDepth(pathOf(a)))
}

/** Order items shallowest-path-first (parent before child) — for puts. */
export function sortParentFirst<T>(items: T[], pathOf: (t: T) => string): T[] {
	return [...items].sort((a, b) => pathDepth(pathOf(a)) - pathDepth(pathOf(b)))
}

// ── Deterministic conflict resolution (last-writer-wins) ──────────────────────

/**
 * Does `incoming` beat the current `local` state at the same path? The generic
 * LWW rule shared by every backend's apply: higher numeric `version` wins; on an
 * EXACT version tie, the higher source-independent `changeDigest` wins — so both
 * replicas pick the SAME winner and converge instead of swapping. `local === null`
 * (path never touched here) => incoming always wins. Digests are computed only on
 * a tie.
 */
export async function incomingWins(
	incoming: PathChange,
	local: PathChange | null
): Promise<boolean> {
	if (!local) return true
	const dv = compareVersion(incoming.version, local.version)
	if (dv !== 0) return dv > 0
	const [di, dl] = await Promise.all([changeDigest(incoming), changeDigest(local)])
	return di > dl
}

/**
 * Order a coalesced batch for a safe apply / journal: all `delete`s first,
 * child-before-parent (never orphan a live child under a deleted dir), then all
 * `put`s, parent-before-child (the dir exists before its entries).
 */
export function orderForApply(changes: PathChange[]): PathChange[] {
	const deletes = sortChildFirst(
		changes.filter((c) => c.kind === 'delete'),
		(c) => c.path
	)
	const puts = sortParentFirst(
		changes.filter((c) => c.kind === 'put'),
		(c) => c.path
	)
	return [...deletes, ...puts]
}
