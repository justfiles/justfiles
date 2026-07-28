// Planning an Obsidian-vault import. Pure: zip entry names + bytes in, a list of
// notes to write and a list of skips out. No IO, no state — so the rules are
// testable and the GUI stays a thin unzip-and-chunk loop (DESIGN.md §9).

import { isNotePath } from './notes.ts'

export type ImportFile = { path: string; text: string }
export type SkipReason = 'config' | 'junk' | 'attachment'
export type Skip = { path: string; reason: SkipReason }
export type ImportPlan = {
	// Vault folder name, derived from the zip's own name or its single root folder.
	name: string
	files: ImportFile[]
	skipped: Skip[]
	folders: number
}

// A note big enough to be a mistake. Bigger than any prose file, small enough
// that a batch of them still fits in a message.
export const MAX_BYTES = 5_000_000

// Everything Obsidian (or the OS, or a sync conflict) leaves in a vault that is
// not the user's writing.
const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Icon\r|Thumbs\.db)(\/|$)/i
const CONFLICT = /\(conflicted copy[^)]*\)|\bconflicted copy\b/i

/**
 * Should this entry be imported, judged from its NAME and SIZE alone? Callable
 * against a zip's central directory, so an attachment or an absurd file is
 * rejected **before** it is decompressed — a picture-heavy vault (or a zip bomb)
 * must not be inflated into the tab just to be thrown away.
 */
export function screenEntry(path: string, size: number, maxBytes = MAX_BYTES): SkipReason | null {
	return classify(normalize(path)) ?? (size > maxBytes ? 'attachment' : null)
}

/** NFC-normalize a path for display/comparison (see `normalize` below). */
export const normalizePath = (path: string) => normalize(path)

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
 * the archive has no single root folder of its own. `preSkipped` carries entries
 * the caller already rejected without decompressing them (see `screenEntry`).
 */
export function planImport(
	entries: Record<string, Uint8Array>,
	zipName: string,
	options: { maxBytes?: number; preSkipped?: readonly Skip[] } = {}
): ImportPlan {
	const maxBytes = options.maxBytes ?? MAX_BYTES
	const skipped: Skip[] = options.preSkipped ? [...options.preSkipped] : []
	const keep: Array<{ path: string; bytes: Uint8Array }> = []
	for (const [raw, bytes] of Object.entries(entries)) {
		const path = normalize(raw)
		// Directory entries carry no content; folders come from their children.
		if (path.endsWith('/')) continue
		// Re-screened here, not only at the seam: loose dropped files never went
		// through a zip's central directory.
		const reason = screenEntry(path, bytes.length, maxBytes)
		if (reason) skipped.push({ path, reason })
		else keep.push({ path, bytes })
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

	return { name: vaultName(zipName, root), files, skipped, folders: folders.size }
}

// The vault's own folder name wins; otherwise the archive's filename.
export function vaultName(zipName: string, root: string): string {
	if (root) return root
	const base = zipName.slice(zipName.lastIndexOf('/') + 1)
	const dot = base.lastIndexOf('.')
	return (dot > 0 ? base.slice(0, dot) : base) || 'Imported'
}
