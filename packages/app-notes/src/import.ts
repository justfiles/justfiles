// Planning an Obsidian-vault import. Pure: zip entry names + bytes in, a list of
// notes to write and a list of skips out. No IO, no state — so the rules are
// testable and the GUI stays a thin unzip-and-chunk loop (DESIGN.md §9).

import { isCanonicalPath, isNotePath } from './notes.ts'

export type ImportFile = { path: string; text: string }
// An entry to plan: the bytes, and the path they came in under. A LIST, never a
// map keyed by path — two loose files dropped from different folders share a
// basename, and a map would silently keep only the last one.
export type ImportEntry = { path: string; bytes: Uint8Array }
export type SkipReason = 'config' | 'junk' | 'attachment' | 'too much'
export type Skip = { path: string; reason: SkipReason }
export type ImportPlan = {
	// Vault folder name, derived from the zip's own name or its single root folder.
	name: string
	files: ImportFile[]
	skipped: Skip[]
	folders: number
	// True when the drop hit a ceiling and the rest was refused, so the GUI can say
	// the import is PARTIAL rather than reporting a clean success.
	stopped: boolean
}

// A note big enough to be a mistake. Bigger than any prose file, small enough
// that a batch of them still fits in a message.
export const MAX_BYTES = 5_000_000

// …and the ceilings for the archive as a WHOLE. Per-entry limits do not bound an
// import: a thousand individually-legal 4 MB notes is 4 GB inflated into the tab,
// which kills it. Generous next to a real vault (kepano's is ~1k notes, a few MB).
export const MAX_FILES = 20_000
export const MAX_TOTAL_BYTES = 100_000_000

// Everything Obsidian (or the OS, or a sync conflict) leaves in a vault that is
// not the user's writing.
const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Icon\r|Thumbs\.db)(\/|$)/i
const CONFLICT = /\(conflicted copy[^)]*\)|\bconflicted copy\b/i

/** NFC-normalize a path for display/comparison (see `normalize` below). */
export const normalizePath = (path: string) => normalize(path)

/**
 * Should this entry be read at all, judged from its NAME and a DECLARED size? Pure,
 * so it can be asked before any bytes exist — against a zip entry's header, or a
 * loose `File.size`. It does not charge the drop's budget: a declared size is a
 * claim, and a streamed archive may not declare one at all (see `admit`).
 */
export function screenEntry(path: string, size: number, maxBytes = MAX_BYTES): SkipReason | null {
	return classify(normalize(path)) ?? (size > maxBytes ? 'attachment' : null)
}

/**
 * The ledger for ONE drop: what it refused, and how much it has let through. It
 * counts only bytes that REALLY exist — `charge` is called with a buffer's length,
 * never with a header's claim — because a claim of zero is exactly what a streamed
 * archive gives you, and a budget charged zero bounds nothing. Nothing is memoized
 * either: two entries can share a path (a drop of same-named files), and each costs.
 */
export type Screen = {
	/** Charge real bytes. `false` = a ceiling is spent, so these bytes must be dropped. */
	charge(path: string, size: number): boolean
	/** Record a refusal: a name/size rule, or an entry that outgrew its own header. */
	skip(path: string, reason: SkipReason): void
	readonly skipped: readonly Skip[]
	readonly stopped: boolean
}

export function createScreen(limits: { maxFiles?: number; maxTotalBytes?: number } = {}): Screen {
	const maxFiles = limits.maxFiles ?? MAX_FILES
	const maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_BYTES
	const skipped: Skip[] = []
	let files = 0
	let bytes = 0
	let stopped = false
	return {
		charge(raw, size) {
			const path = normalize(raw)
			if (files + 1 > maxFiles || bytes + size > maxTotalBytes) {
				stopped = true
				skipped.push({ path, reason: 'too much' })
				return false
			}
			files++
			bytes += size
			return true
		},
		skip(raw, reason) {
			skipped.push({ path: normalize(raw), reason })
		},
		get skipped() {
			return skipped
		},
		get stopped() {
			return stopped
		}
	}
}

/**
 * Judge an entry whose bytes are IN HAND and charge them — the one place the
 * budget moves. Returns the entry to keep, or `null` when it was refused (already
 * recorded as a skip). Both readers funnel through here, so "how much have we let
 * in" has a single answer regardless of which seam the bytes came from.
 */
export function admit(
	entry: ImportEntry,
	screen: Screen,
	maxBytes = MAX_BYTES
): ImportEntry | null {
	const path = normalize(entry.path)
	// A zip's directory entries carry no content and are not a refusal worth
	// reporting — folders come from their children. The rule belongs here, with the
	// other reasons an entry does not become a note.
	if (path.endsWith('/')) return null
	const reason = screenEntry(path, entry.bytes.length, maxBytes)
	if (reason) {
		screen.skip(path, reason)
		return null
	}
	if (!screen.charge(path, entry.bytes.length)) return null
	return { path, bytes: entry.bytes }
}

function classify(path: string): SkipReason | null {
	// A name we could not write as one path: `a//b.md`, `/abs.md`. An archive is
	// untrusted input, so a spelling the volume would rewrite is DROPPED here (with a
	// report) rather than sent on to be refused at the procedure — one odd entry must
	// not cost the user the other thousand. Same rule as the procedure's, one call.
	if (!isCanonicalPath(`/${path}`)) return 'junk'
	// OS and sync debris first: `.DS_Store` and `__MACOSX/._x` are dotted too, and
	// "junk" is the more useful thing to tell the user.
	if (JUNK.test(path) || CONFLICT.test(path)) return 'junk'
	// `.obsidian/`, `.trash/`, `.git/` and every other dotted segment: config and
	// caches, none of which mean anything outside Obsidian.
	if (path.split('/').some((segment) => segment.startsWith('.'))) return 'config'
	// Attachments, `.canvas`, `.base`, plugin data: real content, but not text we
	// can carry over the GUI→reducer seam (which is JSON-safe). Reported, not
	// silently dropped.
	if (!isNotePath(path)) return 'attachment'
	return null
}

/**
 * The single top folder every entry shares, if there is one — a vault zipped on
 * the desktop is `MyVault/Notes/Kyoto.md`, and importing that nested inside
 * another folder would double the nesting.
 */
export function commonRoot(paths: readonly string[]): string {
	let root: string | null = null
	for (const path of paths) {
		const cut = path.indexOf('/')
		if (cut <= 0) return ''
		const head = path.slice(0, cut)
		if (root === null) root = head
		else if (root !== head) return ''
	}
	return root ?? ''
}

// macOS zips store decomposed unicode (NFD): "Kyōto" arrives as "Kyo\u0304to".
// Left alone it looks identical but compares unequal, so a re-import (or a
// wikilink) silently misses. Normalizing per segment is the whole fix.
const normalize = (path: string) =>
	path
		.split('/')
		.map((segment) => segment.normalize('NFC'))
		.join('/')

const decoder = new TextDecoder()

/**
 * Turn ADMITTED entries into a plan — structure only: strip the vault's own root
 * folder, decode the text, count the folders, and carry the screen's report. The
 * entries must already have been through `admit` (which is what charged them), so
 * that "how much have we let in" is decided in exactly one place instead of being
 * re-derived here from sizes that may have been claims.
 */
export function planImport(
	entries: readonly ImportEntry[],
	zipName: string,
	screen: Screen = createScreen()
): ImportPlan {
	// The root is computed over KEPT paths only — a macOS zip carries `__MACOSX/`
	// beside the vault folder, which would otherwise look like a second root and
	// leave the whole vault nested one level deeper than it should be.
	const root = commonRoot(entries.map((entry) => entry.path))
	const strip = root ? root.length + 1 : 0

	const files: ImportFile[] = []
	const folders = new Set<string>()
	for (const entry of entries) {
		const relative = entry.path.slice(strip)
		if (relative === '') continue
		files.push({ path: relative, text: decoder.decode(entry.bytes) })
		const cut = relative.lastIndexOf('/')
		if (cut <= 0) continue
		// Every ancestor is a folder the import will create.
		for (let at = relative.slice(0, cut); at !== ''; at = at.slice(0, at.lastIndexOf('/'))) {
			folders.add(at)
			if (!at.includes('/')) break
		}
	}

	return {
		name: vaultName(zipName, root),
		files,
		skipped: [...screen.skipped],
		folders: folders.size,
		stopped: screen.stopped
	}
}

// The vault's own folder name wins; otherwise the archive's filename.
export function vaultName(zipName: string, root: string): string {
	if (root) return root
	const base = zipName.slice(zipName.lastIndexOf('/') + 1)
	const dot = base.lastIndexOf('.')
	return (dot > 0 ? base.slice(0, dot) : base) || 'Imported'
}
