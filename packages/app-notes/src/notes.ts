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

/**
 * True only of the ONE spelling the volume gives a path: absolute, no empty
 * segments (`//x`, `/x/`), no `.`/`..`.
 *
 * Every rule in this module is lexical — `isUnder`, `illegalMove`, `parentDir`,
 * `joinPath` all reason about strings — and a lexical rule is a claim about a path
 * only if the volume agrees with the spelling. It does not: `/Trips/`, `//Trips` and
 * `/Trips` all reach the same directory, so `isUnder('/Trips/Sub', '/Trips/')` is
 * `false` while the move it guards is very much a move into itself.
 *
 * So the seam DEMANDS the canonical spelling instead of repairing spellings. Two
 * ways to write one path would otherwise circulate through state, comparisons and
 * caches; refusing is a one-line rule, normalizing is a permanent invariant to keep.
 * Notes are named literally, so nothing legitimate needs another spelling.
 */
export function isCanonicalPath(path: string): boolean {
	if (path === '/') return true
	if (!path.startsWith('/') || path.endsWith('/')) return false
	// A backslash is a separator on some hosts and an ordinary letter on others, so a name
	// containing one does not mean one thing — and this predicate's whole job is that there
	// is only one spelling. It matters most where the names are untrusted: a dropped
	// archive offering `..\\system\\payload.md` is one segment to every check here and two
	// path components to `node:path.join`, which is how a member escapes the volume.
	if (path.includes('\\')) return false
	return path
		.slice(1)
		.split('/')
		.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * True when `path` NAMES something inside the knowledge base — a note or a folder.
 *
 * Canonical is not enough: `/` is a perfectly canonical path and it is the knowledge
 * base itself, not an entry in it. Every operation that acts on a *thing* has to
 * refuse it, and refusing it in one predicate is the only way that holds — `remove('/')`
 * deletes every note the user has, and an import member of `''` joins to `/`, which
 * `claimPath` then numbers into an invisible file called ` 2`.
 */
export function namesEntry(path: string): boolean {
	return path !== '/' && isCanonicalPath(path)
}

/** True when `path` is `dir` itself or lives under it (for folder renames). */
/**
 * Did this failure carry one of these filesystem codes? Read from the START of the
 * message, because a code is what the volume *said* — not text that happens to appear
 * somewhere inside it. `EACCES: /notes/ENOENT.md` is a note that is very much still
 * there, and taking it for "gone" would detach a dirty buffer and fork a duplicate.
 */
export function failedWith(failure: unknown, ...codes: string[]): boolean {
	const message = failure instanceof Error ? failure.message : String(failure)
	const said = /^([A-Z]{4,10})\b/.exec(message)?.[1]
	return said !== undefined && codes.includes(said)
}

export function isUnder(path: string, dir: string): boolean {
	return path === dir || path.startsWith(dir === '/' ? '/' : `${dir}/`)
}

/** `Kyoto.md` + 2 → `Kyoto 2.md`; the extension is kept, not shifted. */
export function numberedPath(path: string, n: number): string {
	const dot = path.lastIndexOf('.')
	const cut = dot > path.lastIndexOf('/') ? dot : path.length
	return `${path.slice(0, cut)} ${n}${path.slice(cut)}`
}

/**
 * Why this move must be refused, or `null` if it may proceed. The volume's
 * `rename` is a POSIX primitive: it happily rebinds a directory's inode beneath
 * one of its own descendants, leaving a cyclic subtree unreachable from the root.
 * Every destination rule lives here, so the reducer has one guard and the GUI, the
 * tree's drag/drop and the agent all inherit it.
 */
export function illegalMove(from: string, to: string): string | null {
	if (from === '/') return 'the knowledge base root cannot be moved'
	if (to === from) return null // a no-op, not an error
	if (isUnder(to, from)) return `“${noteTitle(from)}” cannot be moved inside itself`
	return null
}

/**
 * A filename from a title, kept as close to the title as the filesystem allows: case
 * and spaces survive (`Remember the milk` → `Remember the milk`), only genuinely unsafe
 * characters are dropped. Imported names are NOT run through this — they are preserved
 * verbatim (DESIGN.md §4).
 *
 * This REPAIRS whatever it is given, which is right for a name that arrives as data (the
 * agent's `create`, a note re-created after the one it held was deleted). A name a person
 * typed into the name field goes through `illegalName` FIRST — see there.
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

/**
 * Does a half-typed NAME still mean something, now that the buffer holding those words sits
 * at `now` instead of `was`? (`null` on either side = no address at all.)
 *
 * A name draft is about the WORDS in the editor, not about a path — the same thing the buffer
 * machine says about bytes — and every way that has been got wrong is a case here:
 *
 *   • `now === was`: nothing happened. Obviously survives — and this is also the answer for a
 *     RENAME, because the caller that knows a move happened re-points the draft as the buffer
 *     follows it (`followMove` in gui.tsx). By the time an address change reaches this rule it
 *     is therefore unexplained, which is what makes the last line safe.
 *   • `now === null`: the words lost their address — a save that failed because the note was
 *     deleted underneath. The draft is then the ONLY record of the name the user asked for, so
 *     dropping it here costs them the name while keeping the words.
 *   • `was === null`: the words gained one — they were re-created after that deletion. Same
 *     words, so the same draft still names them.
 *   • otherwise: the buffer came to hold a DIFFERENT note (an agent `open`). Committing then
 *     renames a note the user never looked at, so the draft cannot follow.
 */
export function draftSurvives(was: string | null, now: string | null): boolean {
	return now === was || now === null || was === null
}

/**
 * Why this typed NAME cannot be used, or `null` if it can — the human half of the naming
 * rules, mirroring `illegalMove` for destinations.
 *
 * This and `sanitizeName` are the same rules read two ways. Sanitize repairs a name that
 * arrives as data; this JUDGES a name someone typed, where repairing silently is the wrong
 * answer — they can see the field, and a name that quietly comes back different is a
 * surprise about where their note now lives. So it reports only what is genuinely
 * unusable and stays quiet about tidying: `Kyoto  trip` is not worth refusing over a
 * double space, and `sanitizeName` still collapses it after this says yes.
 *
 * An EMPTY name is not judged here. Clearing the field is not an error, it is "no change",
 * and only the caller knows what the field was showing before.
 */
export function illegalName(name: string): string | null {
	const trimmed = name.trim()
	if (trimmed === '') return null
	// A fresh regex from the same source, because `UNSAFE` is `/g` and therefore stateful:
	// `.test` leaves `lastIndex` behind it, so every second identical check would pass.
	if (new RegExp(UNSAFE.source).test(trimmed)) return 'a name cannot contain \\ / # | ^ [ ]'
	if (printable(trimmed) !== trimmed) return 'a name cannot contain control characters'
	// A leading dot hides the file from every other tool; `sanitizeName` strips it, which
	// would silently rename `.plan` to `plan`.
	if (trimmed.startsWith('.')) return 'a name cannot start with a dot'
	if (trimmed.length > NAME_MAX) return `a name can be at most ${NAME_MAX} characters`
	return null
}

/**
 * Where a rename should actually land. A user retyping a note's name drops the extension
 * (`Kyoto`, not `Kyoto.md`), and a note that stops being `.md`/`.txt` stops being a note
 * — so the source's extension is carried over when the new name has none.
 *
 * `sourceIsNote` is passed in rather than inferred from the spelling, because the
 * spelling lies: a FOLDER called `Archive.md` reads as a note to any suffix test, and
 * renaming it to `/Archive` would then "preserve" its way straight back to `/Archive.md`
 * — a rename that silently does nothing. Only the entry itself knows which it is.
 */
export function renameTarget(from: string, to: string, sourceIsNote: boolean): string {
	if (!sourceIsNote || isNotePath(to)) return to
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
