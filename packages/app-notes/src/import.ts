// Planning an Obsidian-vault import. Pure: zip entry names + bytes in, a list of
// notes to write and a list of skips out. No IO, no state — so the rules are
// testable and the GUI stays a thin unzip-and-chunk loop (DESIGN.md §9).

import { isNotePath } from './notes.ts'

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
 * The screen for ONE drop: per-entry rules plus the running totals, and the tally
 * of what it refused. It is the *only* thing that decides whether bytes get read,
 * so both seams ask it — a zip's central directory (`filter`, before inflating) and
 * a loose `File` (its `size`, before `arrayBuffer()`). Answers are remembered per
 * path, so asking twice is free and cannot double-charge the budget.
 */
export type Screen = {
	accept(path: string, size: number): boolean
	// A refusal discovered after `accept` said yes — a streamed archive need not
	// declare its entry sizes, so the only place an oversized one shows up is
	// mid-inflate. Reported like any other skip.
	reject(path: string, reason: SkipReason): void
	readonly skipped: readonly Skip[]
	readonly stopped: boolean
}

export function createScreen(maxBytes = MAX_BYTES): Screen {
	const answers = new Map<string, boolean>()
	const skipped: Skip[] = []
	let files = 0
	let bytes = 0
	let stopped = false
	return {
		accept(raw, size) {
			const path = normalize(raw)
			const prior = answers.get(path)
			if (prior !== undefined) return prior
			const reason =
				classify(path) ??
				(size > maxBytes
					? 'attachment'
					: files + 1 > MAX_FILES || bytes + size > MAX_TOTAL_BYTES
						? 'too much'
						: null)
			if (reason === 'too much') stopped = true
			if (reason) skipped.push({ path, reason })
			else {
				files++
				bytes += size
			}
			answers.set(path, reason === null)
			return reason === null
		},
		reject(raw, reason) {
			const path = normalize(raw)
			answers.set(path, false)
			skipped.push({ path, reason })
		},
		get skipped() {
			return skipped
		},
		get stopped() {
			return stopped
		}
	}
}

function classify(path: string): SkipReason | null {
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
 * Turn unzipped entries into a plan. `zipName` names the destination folder when
 * the archive has no single root folder of its own. `screen` is the drop's screen
 * (see `createScreen`) — pass the one already used to filter the archive, so its
 * refusals and its remaining budget carry into the plan.
 */
export function planImport(
	entries: readonly ImportEntry[],
	zipName: string,
	options: { screen?: Screen } = {}
): ImportPlan {
	const screen = options.screen ?? createScreen()
	const keep: ImportEntry[] = []
	for (const entry of entries) {
		const path = normalize(entry.path)
		// Directory entries carry no content; folders come from their children.
		if (path.endsWith('/')) continue
		if (screen.accept(path, entry.bytes.length)) keep.push({ path, bytes: entry.bytes })
	}

	// The root is computed over KEPT paths only — a macOS zip carries `__MACOSX/`
	// beside the vault folder, which would otherwise look like a second root and
	// leave the whole vault nested one level deeper than it should be.
	const root = commonRoot(keep.map((entry) => entry.path))
	const strip = root ? root.length + 1 : 0

	const files: ImportFile[] = []
	const folders = new Set<string>()
	for (const entry of keep) {
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
