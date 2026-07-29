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
	// A COUNT, plus a bounded sample for the log: an archive can hold millions of
	// entries we refuse, and remembering each one is itself the unbounded thing.
	skipped: number
	examples: Skip[]
	// Everything the drop was asked about, so a refusal can say what it walked.
	members: number
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

// …and a ceiling on how many members we will even LOOK at. Neither bound above stops
// an archive whose entries are all refused — attachments, `.obsidian/`, junk — and
// "examine each and remember it" is unbounded work on unbounded memory. Far above any
// real vault (kepano's is ~1k notes; a photo-heavy vault runs to tens of thousands of
// files), so hitting this means the archive is not a vault.
export const MAX_MEMBERS = 200_000

// How many refusals are kept as examples for the log. The count is exact; the list is
// a sample, because the list is the part that grows.
const MAX_EXAMPLES = 50

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
	/** The archive's own root folder, if it has exactly one — see `createScreen`. */
	readonly root: string
	/**
	 * A member that is neither content nor a refusal — a zip's folder entries, which
	 * are not notes and are not worth reporting (folders come from their children).
	 * Counted as WORK even so: an archive of a million empty directories has to reach
	 * the member ceiling like any other, and a ceiling only what-we-keep can reach is
	 * no ceiling at all.
	 */
	ignore(path: string): void
	/** How many members were refused — a count, never a list (see `MAX_EXAMPLES`). */
	readonly skipped: number
	/** How many members were examined at all: kept + refused + ignored. */
	readonly members: number
	readonly examples: readonly Skip[]
	readonly stopped: boolean
}

export function createScreen(
	limits: { maxFiles?: number; maxTotalBytes?: number; maxMembers?: number } = {}
): Screen {
	const maxFiles = limits.maxFiles ?? MAX_FILES
	const maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_BYTES
	const maxMembers = limits.maxMembers ?? MAX_MEMBERS
	const examples: Skip[] = []
	let skipped = 0
	let members = 0
	let files = 0
	let bytes = 0
	let stopped = false
	// EVERY member costs, whether it becomes a note or not. A refusal is cheap but not
	// free, and an archive of nothing but attachments would otherwise be walked to the
	// end for no possible result — the ceilings above only count what we keep.
	const member = () => {
		if (++members > maxMembers) {
			stopped = true
			return false
		}
		return true
	}
	const refuse = (path: string, reason: SkipReason) => {
		skipped++
		if (examples.length < MAX_EXAMPLES) examples.push({ path, reason })
	}
	// The archive's layout, witnessed as it streams past: does every member sit under
	// ONE top-level folder (a vault zipped on the desktop is `MyVault/Notes/Kyoto.md`,
	// and importing that nested inside another folder would double the nesting)?
	//
	// It has to be judged on the LAYOUT, not on the notes we kept. Kept-only gets both
	// of the real cases wrong in opposite directions: a macOS zip carries `__MACOSX/`
	// beside the vault, so counting everything sees two roots and leaves the vault a
	// level too deep — while a zip of a vault's *contents* has `.obsidian/` beside the
	// user's own `Trips/`, so counting only notes sees `Trips` as packaging and flattens
	// a folder the user made. So: every member is evidence EXCEPT OS packaging.
	//
	// Bounded to one remembered name, because two different tops is already the answer.
	let top: string | null = null
	let manyTops = false
	const layout = (path: string) => {
		// OS packaging was added by whatever zipped the folder and says nothing about where
		// the vault's root is. Everything else sits exactly where the VAULT put it —
		// `.obsidian/`, a `.trash/`, an attachment, a conflicted copy — so it is evidence
		// whether or not we keep it. Which members are *interesting* is a different question
		// from which members describe the shape, and this asks only the second one.
		if (manyTops || JUNK.test(path)) return
		// …and a name we could not even spell describes nothing trustworthy: an archive is
		// untrusted input, so a member that would climb out of the volume must not get a say
		// in where the vault's root is. (Directory entries keep their trailing slash.)
		if (!isCanonicalPath(`/${path.replace(/\/+$/, '')}`)) return
		const cut = path.indexOf('/')
		// No slash = a member at the archive's own root, so there is no root folder.
		const head = cut <= 0 ? '' : path.slice(0, cut)
		if (top === null) top = head
		else if (top !== head) manyTops = true
	}
	return {
		charge(raw, size) {
			const path = normalize(raw)
			layout(path)
			if (!member() || files + 1 > maxFiles || bytes + size > maxTotalBytes) {
				stopped = true
				refuse(path, 'too much')
				return false
			}
			files++
			bytes += size
			return true
		},
		skip(raw, reason) {
			const path = normalize(raw)
			layout(path)
			member()
			refuse(path, reason)
		},
		ignore(raw) {
			const path = normalize(raw)
			layout(path)
			member()
		},
		get skipped() {
			return skipped
		},
		get members() {
			return members
		},
		get examples() {
			return examples
		},
		get stopped() {
			return stopped
		},
		get root() {
			return manyTops || top === null || top === '' ? '' : top
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
	// other reasons an entry does not become a note; the ledger still hears about it,
	// so every member touches it exactly once whichever seam saw it.
	if (path.endsWith('/')) {
		screen.ignore(path)
		return null
	}
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
	// The vault's own root folder, witnessed by the screen as the archive streamed
	// past — every member is evidence, not just the notes we kept (see `createScreen`).
	//
	// …but only if it saw the WHOLE archive. A drop that hit a ceiling was abandoned
	// mid-stream, so "every member shares this top folder" is a statement about the
	// prefix we read: the entry that would have disproved it may be one of the ones we
	// never looked at. Stripping on that evidence flattens a folder the user made. So a
	// partial import keeps the archive's own shape, one level deeper than a whole one —
	// visible, and a drag away from fixing — instead of guessing.
	const root = screen.stopped ? '' : screen.root
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
		skipped: screen.skipped,
		examples: [...screen.examples],
		members: screen.members,
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
