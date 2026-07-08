/**
 * The `/fs` sync-service wire contract — path-addressed, schema-first.
 *
 * One canonical Zod schema per concept, with the TS types `z.infer`-ed so there
 * is no hand-written interface to drift. Shared by the local `SyncReplica`, the
 * remote HTTP client, and the `/fs` transport in `@justfiles/core`.
 *
 * JSON encodings: bigint (`mtimeNs`/`size`) as decimal strings, xattr bytes as
 * base64, `version` as a decimal string (compared NUMERICALLY, never lexically).
 */

import { z } from 'zod'
import type { InodeMeta } from './storage'
import { FileType } from './types'

// ── Identity primitives ──────────────────────────────────────────────────────

/**
 * Canonical path: absolute, NFC, POSIX case-sensitive, '/'-separated, no empty
 * segments, no '.'/'..', no trailing slash (except root '/'). This is the
 * cross-replica identity, so the contract validates it — not bare z.string().
 */
export function isCanonicalPath(p: string): boolean {
	if (typeof p !== 'string' || p.length === 0) return false
	if (p === '/') return true
	if (!p.startsWith('/')) return false
	if (p.endsWith('/')) return false
	if (p.normalize('NFC') !== p) return false
	for (const seg of p.slice(1).split('/')) {
		if (seg === '' || seg === '.' || seg === '..') return false
	}
	return true
}

export const SyncPath = z.string().refine(isCanonicalPath, 'non-canonical path')

/**
 * Content identity = lowercase hex SHA-256 (64 chars), matching `sha256Hex`. The
 * blob store addresses it under `…/fs/blobs/sha256/<hash>`; the hash itself is
 * bare hex, NOT prefixed 'sha256-…'. Reject anything else.
 */
export const ContentHash = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * Per-path Lamport version. DECIMAL STRING on the wire (like mtimeNs/size), NOT
 * z.number(): avoids the 2^53 ceiling and can widen to bigint without a wire
 * change. Persisted/internal versions are v1-bounded integers; the string is the
 * wire boundary only. COMPARE NUMERICALLY, never lexicographically.
 */
export const Version = z.string().regex(/^(0|[1-9][0-9]*)$/)

// ── Metadata + change ─────────────────────────────────────────────────────────

export const SyncMeta = z.object({
	type: z.enum(FileType), // Regular | Directory | Symlink — enum, not any number
	mode: z.number().int(),
	mtimeNs: z.string(), // bigint as string
	size: z.string(), // bigint as string
	// NO ctimeNs (intentional): ctime is POSIX-local and cannot be set by
	// userspace. The applying replica sets ctime = apply-time locally; it never
	// crosses the wire.
	symlinkTarget: z.string().optional(),
	// COMPLETE user-xattr snapshot for the path (name -> base64), never a patch.
	// Apply replaces the inode's entire user-xattr set; names absent from it are
	// deleted locally. Omitted/empty = no user xattrs. `trusted.sync.*` are
	// local-only and excluded from this map both ways.
	xattrs: z.record(z.string(), z.string()).optional()
})

/**
 * A change to the tree, addressed by path. `version` drives generic LWW.
 * `source` = ORIGIN client-id, so a replica filters its own echoes on pull. It
 * is SERVER-AUTHORITATIVE in the star topology: on the PUSH endpoint `source` is
 * NEVER read from the body — the server stamps every change with the caller's
 * client-id from the authenticated request.
 *
 * `contentHash` invariants are SCHEMA-ENFORCED: a regular-file put MUST carry a
 * hash (empty files included) so every regular file is hydratable; dirs/symlinks
 * MUST NOT carry one. The root `/` is never a change subject.
 */
export const PathChange = z
	.discriminatedUnion('kind', [
		z.object({
			kind: z.literal('put'),
			path: SyncPath,
			version: Version,
			source: z.string().optional(),
			contentHash: ContentHash.optional(),
			meta: SyncMeta
		}),
		z.object({
			kind: z.literal('delete'),
			path: SyncPath,
			version: Version,
			source: z.string().optional()
		})
	])
	.superRefine((c, ctx) => {
		if (c.path === '/')
			ctx.addIssue({ code: 'custom', message: 'root / is never a PathChange subject' })
		if (c.kind !== 'put') return
		const isRegular = c.meta.type === FileType.Regular
		if (isRegular && !c.contentHash)
			ctx.addIssue({ code: 'custom', message: 'regular-file put requires contentHash' })
		if (!isRegular && c.contentHash)
			ctx.addIssue({ code: 'custom', message: 'dir/symlink put must not carry contentHash' })
	})

export type SyncMeta = z.infer<typeof SyncMeta>
export type PathChange = z.infer<typeof PathChange>

// ── Numeric version helpers (never compare the decimal strings lexically) ─────

/** Parse a wire `Version` (decimal string) to a number for comparison. */
export function parseVersion(v: string): number {
	return Number(v)
}

/** Encode a v1-bounded integer version as its decimal wire string. */
export function encodeVersion(v: number): string {
	return String(v)
}

/** Numeric comparison of two wire versions: <0, 0, >0. */
export function compareVersion(a: string, b: string): number {
	return parseVersion(a) - parseVersion(b)
}

// ── Meta encode/decode (the one place InodeMeta <-> SyncMeta is converted) ─────

/** Portable (browser + node) base64 encode of raw bytes — standard alphabet. */
function toBase64(b: Uint8Array): string {
	let s = ''
	for (const byte of b) s += String.fromCharCode(byte)
	return btoa(s)
}

/**
 * Convert a backend `InodeMeta` (bigint sizes/times, no wire encoding) plus its
 * user-xattr snapshot into the JSON-encoded `SyncMeta`. Excludes `ctimeNs` and
 * `trusted.sync.*` xattrs.
 */
export function syncMetaFromInode(meta: InodeMeta, xattrs?: Record<string, Uint8Array>): SyncMeta {
	const sm: SyncMeta = {
		type: meta.type,
		mode: meta.mode,
		mtimeNs: String(meta.mtimeNs),
		size: String(meta.size)
	}
	if (meta.symlinkTarget !== undefined) sm.symlinkTarget = meta.symlinkTarget
	// Complete user-xattr snapshot, base64-encoded; `trusted.sync.*` is local-only
	// and never crosses the wire. Omit the field entirely when there are none.
	if (xattrs) {
		const encoded: Record<string, string> = {}
		for (const [name, value] of Object.entries(xattrs)) {
			if (name.startsWith('trusted.sync.')) continue
			encoded[name] = toBase64(value)
		}
		if (Object.keys(encoded).length > 0) sm.xattrs = encoded
	}
	return sm
}

/**
 * Convert a wire `SyncMeta` back into a backend `InodeMeta` patch (ctime is set
 * locally at apply time, never from the wire) plus the decoded xattr snapshot.
 */
export function inodeMetaFromSync(_meta: SyncMeta): {
	meta: Partial<InodeMeta>
	xattrs: Record<string, Uint8Array>
} {
	// TODO(path-sync): decode into InodeMeta patch + Uint8Array xattr map.
	throw new Error('not implemented')
}

// ── Conflict tie-break + coalescing ───────────────────────────────────────────

/**
 * Canonical SHA-256 over a change's DURABLE file-state — the tie-break term after
 * numeric `version`. Includes `kind` and (for puts) `type, mode, mtimeNs, size,
 * symlinkTarget, sorted xattrs, contentHash`. Deliberately EXCLUDES `source` and
 * any echo-suppression metadata so the same logical change digests identically
 * before vs after a server stamps its origin.
 */
export function changeDigest(_change: PathChange): Promise<string> {
	// TODO(path-sync): stable canonical serialization -> sha256 hex.
	throw new Error('not implemented')
}

/** Collapse multiple changes on one path to its final state, preserving order. */
export function coalesceByPath(_changes: PathChange[]): PathChange[] {
	// TODO(path-sync): last-writer-per-path within a page, keeping tree ordering.
	throw new Error('not implemented')
}
