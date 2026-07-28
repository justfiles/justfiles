// Pure path/name/search helpers for the `/notes` knowledge base. No IO, no
// state — so the reducer, the GUI and the tests share one set of rules
// (DESIGN.md §4). Every path here is root-relative inside the `/notes` chroot.

// Both extensions are the same thing — plain text. `.md` is the default for new
// notes; `.txt` stays readable so notes written before the switch (and by other
// tools) keep showing up.
export const NOTE_EXT = '.md'
const NOTE_EXTS = ['.md', '.txt']

const NAME_MAX = 100
// Path separators plus the characters Obsidian itself warns break links
// (`# | ^ [ ]`), so a title stays addressable if we ever resolve `[[wikilinks]]`.
const UNSAFE = /[\\/#|^[\]]/g

// Control characters can't go in a filename either; strip them by code point
// (a regex class of control chars is itself a lint smell).
function printable(input: string): string {
	return Array.from(input, (ch) => (ch < ' ' || ch === '\u007f' ? ' ' : ch)).join('')
}

export function isNotePath(path: string): boolean {
	return NOTE_EXTS.some((ext) => path.toLowerCase().endsWith(ext))
}

/** `/Trips/Kyoto.md` → `Kyoto`; the note's display name. */
export function noteTitle(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1)
	const ext = NOTE_EXTS.find((candidate) => name.toLowerCase().endsWith(candidate))
	return ext ? name.slice(0, -ext.length) : name
}

/** `/Trips/Kyoto.md` → `Trips/Kyoto`; what search matches and rows show. */
export function displayPath(path: string): string {
	const dir = parentDir(path)
	return dir === '/' ? noteTitle(path) : `${dir.slice(1)}/${noteTitle(path)}`
}

/** `/Trips/Kyoto.md` → `/Trips`; `/Kyoto.md` → `/`. */
export function parentDir(path: string): string {
	const cut = path.lastIndexOf('/')
	return cut <= 0 ? '/' : path.slice(0, cut)
}

export function joinPath(dir: string, name: string): string {
	return dir === '/' ? `/${name}` : `${dir}/${name}`
}

/** True when `path` is `dir` itself or lives under it (for folder renames). */
export function isUnder(path: string, dir: string): boolean {
	return path === dir || path.startsWith(dir === '/' ? '/' : `${dir}/`)
}

/**
 * A filename from a human title, kept as close to the title as the filesystem
 * allows: case and spaces survive (`Remember the milk` → `Remember the milk`),
 * only genuinely unsafe characters are dropped. Imported names are NOT run
 * through this — they are preserved verbatim (DESIGN.md §4).
 */
export function sanitizeName(input: string): string {
	const out = printable(input.normalize('NFC'))
		.replace(UNSAFE, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^\.+/, '')
		.trim()
		.slice(0, NAME_MAX)
		.trim()
	return out || 'Untitled'
}

export function firstLine(text: string): string {
	for (const line of text.split('\n')) {
		const trimmed = line.trim()
		if (trimmed) return trimmed
	}
	return ''
}

/**
 * Where a rename should actually land. A user retyping a note's name drops the
 * extension (`Kyoto`, not `Kyoto.md`), and a note that stops being `.md`/`.txt`
 * stops being a note — so the source's extension is carried over when the new
 * name has none. Folders keep whatever was typed.
 */
export function renameTarget(from: string, to: string): string {
	if (!isNotePath(from) || isNotePath(to)) return to
	const ext = NOTE_EXTS.find((candidate) => from.toLowerCase().endsWith(candidate)) ?? NOTE_EXT
	return `${to}${ext}`
}

/**
 * Rank notes for the search field. Every whitespace/slash-separated token must
 * appear somewhere in `Trips/Kyoto`, so `kyo trip` and `trips/kyo` both hit;
 * a title match outranks a folder-only match, then recency decides.
 */
export function matchNotes<T extends { path: string; mtime: number }>(
	notes: readonly T[],
	query: string
): T[] {
	const tokens = query
		.toLowerCase()
		.split(/[\s/]+/)
		.filter(Boolean)
	if (tokens.length === 0) return [...notes]
	const scored: Array<{ note: T; rank: number }> = []
	for (const note of notes) {
		const title = noteTitle(note.path).toLowerCase()
		const full = displayPath(note.path).toLowerCase()
		if (!tokens.every((token) => full.includes(token))) continue
		const first = tokens[0] ?? ''
		const rank = title.startsWith(first) ? 0 : tokens.every((t) => title.includes(t)) ? 1 : 2
		scored.push({ note, rank })
	}
	return scored
		.sort((a, b) => a.rank - b.rank || b.note.mtime - a.note.mtime)
		.map((entry) => entry.note)
}
