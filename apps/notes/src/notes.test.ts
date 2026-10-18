import { expect, test } from 'vitest'
import {
	cutKept,
	displayPath,
	draftSurvives,
	failedWith,
	illegalMove,
	illegalName,
	isCanonicalPath,
	isDateStamp,
	isUnder,
	journalPath,
	localDateStamp,
	localTimeStamp,
	matchNotes,
	mergeAppend,
	namesEntry,
	noteTitle,
	renameTarget,
	SCRATCH_FILE,
	sanitizeName,
	splitSelection
} from './notes.ts'

test('titles and display paths drop the extension, keep the folder', () => {
	expect(noteTitle('/Remember the milk.md')).toBe('Remember the milk')
	expect(noteTitle('/Trips/Kyoto.txt')).toBe('Kyoto')
	expect(noteTitle('/Notes/2023-09-12 Meeting.md')).toBe('2023-09-12 Meeting')
	expect(displayPath('/Kyoto.md')).toBe('Kyoto')
	expect(displayPath('/Trips/Japan/Kyoto.md')).toBe('Trips/Japan/Kyoto')
})

test('filenames stay human: case and spaces survive, unsafe characters do not', () => {
	expect(sanitizeName('Remember the milk')).toBe('Remember the milk')
	expect(sanitizeName('  Kyoto   trip  ')).toBe('Kyoto trip')
	// Path separators and the characters Obsidian warns break links are dropped.
	expect(sanitizeName('a/b\\c#d|e^f[g]h')).toBe('a b c d e f g h')
	expect(sanitizeName('.hidden')).toBe('hidden')
	expect(sanitizeName('   ')).toBe('Untitled')
	expect(sanitizeName('#')).toBe('Untitled')
	expect(sanitizeName('x'.repeat(200))).toHaveLength(100)
})

test('isUnder covers the folder itself and its descendants', () => {
	expect(isUnder('/Trips/Kyoto.md', '/Trips')).toBe(true)
	expect(isUnder('/Trips', '/Trips')).toBe(true)
	expect(isUnder('/Trips 2/Kyoto.md', '/Trips')).toBe(false)
	expect(isUnder('/Kyoto.md', '/')).toBe(true)
})

test('search matches folders and titles, ranking titles first then recency', () => {
	const notes = [
		{ path: '/Trips/Kyoto.md', mtime: 1 },
		{ path: '/Kyoto ramen.md', mtime: 2 },
		{ path: '/Kyoto/Notes.md', mtime: 3 },
		{ path: '/Groceries.md', mtime: 4 }
	]
	// Title prefix first (newest of those first), then folder-only matches.
	expect(matchNotes(notes, 'kyoto').map((n) => n.path)).toEqual([
		'/Kyoto ramen.md',
		'/Trips/Kyoto.md',
		'/Kyoto/Notes.md'
	])
	// Tokens may span folder and title, in any order, with `/` as a separator.
	expect(matchNotes(notes, 'trips/kyo').map((n) => n.path)).toEqual(['/Trips/Kyoto.md'])
	expect(matchNotes(notes, 'kyo trip').map((n) => n.path)).toEqual(['/Trips/Kyoto.md'])
	// An empty query is everything, untouched (the caller already sorted by mtime).
	expect(matchNotes(notes, '')).toHaveLength(4)
	expect(matchNotes(notes, 'nope')).toEqual([])
})

test('a renamed note keeps its extension when the typed name has none', () => {
	expect(renameTarget('/Trips/Kyoto.md', '/Trips/Kyoto 2023', true)).toBe('/Trips/Kyoto 2023.md')
	expect(renameTarget('/Old.txt', '/New', true)).toBe('/New.txt')
	// An explicit extension is respected, and folders are left alone.
	expect(renameTarget('/Kyoto.md', '/Kyoto.txt', true)).toBe('/Kyoto.txt')
	expect(renameTarget('/Trips', '/Travel', false)).toBe('/Travel')
	// The spelling is not the fact: a FOLDER called `Archive.md` renamed to `/Archive`
	// must move, not "keep" an extension it never earned and become a no-op.
	expect(renameTarget('/Archive.md', '/Archive', false)).toBe('/Archive')
	expect(renameTarget('/Archive.md', '/Archive', true)).toBe('/Archive.md')
})

test('a filesystem code is what the volume said, not text found in the message', () => {
	expect(failedWith(new Error('ENOENT: /notes/Kyoto.md'), 'ENOENT', 'EISDIR')).toBe(true)
	expect(failedWith(new Error('EISDIR: /notes/Archive.md'), 'ENOENT', 'EISDIR')).toBe(true)
	// A note called `ENOENT.md` that could not be read is still very much there — reading
	// this as "gone" detaches a dirty buffer and the retry forks a duplicate beside it.
	expect(failedWith(new Error('EACCES: /notes/ENOENT.md'), 'ENOENT', 'EISDIR')).toBe(false)
	expect(failedWith(new Error('the volume is unreachable'), 'ENOENT')).toBe(false)
	expect(failedWith('ENOENT: a string, not an Error', 'ENOENT')).toBe(true)
})

test('a backslash is not a letter in a name — it is a separator somewhere', () => {
	// The check that matters for untrusted names: a dropped archive offering
	// `..\\system\\payload.md` is ONE segment to every check here and two path components
	// to `node:path.join`, which is how a member climbs out of the volume.
	expect(isCanonicalPath('/..\\system\\payload.md')).toBe(false)
	expect(isCanonicalPath('/Trips\\Kyoto.md')).toBe(false)
	expect(namesEntry('/AC\\DC.md')).toBe(false)
	expect(isCanonicalPath('/Trips/Kyoto.md')).toBe(true)
})

test('a path has exactly one accepted spelling', () => {
	expect(isCanonicalPath('/')).toBe(true)
	expect(isCanonicalPath('/Trips/Kyoto.md')).toBe(true)
	expect(isCanonicalPath('/2023-09-12 Meeting.md')).toBe(true)
	// The spellings that make a lexical rule lie: all of these reach /Trips, and
	// `isUnder('/Trips/Sub', …)` is false for every one of them.
	for (const spelling of ['/Trips/', '//Trips', '/Trips//Sub', '/Trips/.', '/Other/../Trips']) {
		expect(isCanonicalPath(spelling)).toBe(false)
		expect(isUnder('/Trips/Sub', spelling)).toBe(false)
	}
	// Relative and empty are not paths this app acts on.
	expect(isCanonicalPath('Trips')).toBe(false)
	expect(isCanonicalPath('')).toBe(false)
})

test('the knowledge base root is a path but not an entry', () => {
	// Canonical is not the same question as "names something". `/` passes the first and
	// must fail the second: it is the knowledge base, and `remove('/')` would delete
	// every note in it.
	expect(isCanonicalPath('/')).toBe(true)
	expect(namesEntry('/')).toBe(false)
	expect(namesEntry('/Kyoto.md')).toBe(true)
	expect(namesEntry('/Trips')).toBe(true)
	// An import member of `''` joins to the root, so it is not a note either.
	expect(namesEntry('/')).toBe(false)
	expect(namesEntry('//Kyoto.md')).toBe(false)
})

test('a move into its own subtree is refused, everything else allowed', () => {
	// `volume.rename` is a POSIX primitive: it will rebind a folder's inode under
	// one of its own descendants and strand the subtree, so this is the guard.
	expect(illegalMove('/Trips', '/Trips/Archive/Trips')).toMatch(/inside itself/)
	expect(illegalMove('/Trips', '/Trips')).toBe(null) // a no-op, not an error
	expect(illegalMove('/', '/Anywhere')).toMatch(/root/)
	// Sibling prefixes are not descendants.
	expect(illegalMove('/Trips', '/Trips 2/Trips')).toBe(null)
	expect(illegalMove('/Trips/Kyoto.md', '/Kyoto.md')).toBe(null)
	expect(illegalMove('/Kyoto.md', '/Trips/Kyoto.md')).toBe(null)
})

test('a typed name is judged, not repaired — but only where it matters', () => {
	// The two are the same rules read two ways: `illegalName` judges what a person typed
	// into the name field (they can see it, so a silent repair is a surprise about where
	// their note now lives), `sanitizeName` repairs what arrives as data.
	expect(illegalName('Kyoto trip')).toBe(null)
	// Tidying is not worth refusing over — sanitize does it silently, and faithfully.
	expect(illegalName('  Kyoto   trip  ')).toBe(null)
	expect(sanitizeName('  Kyoto   trip  ')).toBe('Kyoto trip')
	// What would move the note, hide it, or break a link to it is refused.
	expect(illegalName('Trips/Kyoto')).toMatch(/cannot contain/)
	expect(illegalName('AC\\DC')).toMatch(/cannot contain/)
	expect(illegalName('Kyoto #1')).toMatch(/cannot contain/)
	expect(illegalName('.plan')).toMatch(/dot/)
	expect(illegalName('Kyoto\ttrip')).toMatch(/control/)
	expect(illegalName('x'.repeat(101))).toMatch(/100/)
	// An empty name is not an error: clearing the field means "no change", and only the
	// caller knows what the field was showing.
	expect(illegalName('   ')).toBe(null)
	// The shared pattern is `/g` and therefore stateful — asking twice must not pass the
	// second time because `lastIndex` survived the first `.test`.
	expect(illegalName('a/b')).not.toBe(null)
	expect(illegalName('a/b')).not.toBe(null)
})

test('a half-typed name follows the words, not the address', () => {
	// The rule that has been got wrong in every direction, so it is written down once.
	// Nothing happened, or the note was renamed and the caller already re-pointed the draft:
	expect(draftSurvives('/Kyoto.md', '/Kyoto.md')).toBe(true)
	// The words lost their address — a save that failed because the note was deleted
	// underneath. The draft is the only record of the name that was asked for.
	expect(draftSurvives('/Kyoto.md', null)).toBe(true)
	// …and gained one again, when those same words were re-created.
	expect(draftSurvives(null, '/Kyoto 2.md')).toBe(true)
	// A different note (an agent `open`): committing would rename a note nobody looked at.
	expect(draftSurvives('/Kyoto.md', '/Osaka.md')).toBe(false)
	// Nothing at either end is still "the same nothing".
	expect(draftSurvives(null, null)).toBe(true)
})

test('keeping part of the scratch takes the selection and leaves the rest', () => {
	const text = 'a thought\n\nsomething else'
	// A selection is the unit: filing one thing out of a scratch must not file the others.
	expect(splitSelection(text, 11, 25)).toEqual({
		promoted: 'something else',
		remainder: 'a thought\n\n'
	})
	// No selection — a bare caret — means the whole buffer, and nothing is left behind.
	expect(splitSelection(text, 4, 4)).toEqual({ promoted: text, remainder: '' })
	expect(splitSelection(text, 0, 0)).toEqual({ promoted: text, remainder: '' })
})

test('the day is spelled one way, and the journal note is named by it', () => {
	expect(isDateStamp('2026-06-19')).toBe(true)
	expect(isDateStamp('2026-6-19')).toBe(false)
	expect(isDateStamp('')).toBe(false)
	// A path canonical by construction, so the procedure needs no second check.
	expect(journalPath('2026-06-19')).toBe('/journal/2026-06-19.md')
	expect(isCanonicalPath(journalPath('2026-06-19'))).toBe(true)
	// The user's clock, not the worker's: 23:30 local is still today.
	expect(localDateStamp(new Date(2026, 5, 19, 23, 30))).toBe('2026-06-19')
	expect(isDateStamp(localDateStamp(new Date(2026, 0, 1)))).toBe(true)
	expect(localTimeStamp(new Date(2026, 5, 19, 9, 5))).toBe('09:05')
})

test('the scratch is not a path in the knowledge base', () => {
	// It lives in the app's own volume, so nothing in `/notes` can name it — that is the
	// whole reason it cannot be renamed, deleted or collided with. What the KB's own naming
	// rules would do with such a name is the belt to that braces: they refuse it.
	expect(SCRATCH_FILE).toBe('/scratch.md')
	expect(illegalName('.scratch')).not.toBe(null)
	expect(sanitizeName('.scratch')).toBe('scratch')
})

test('only a pure append is merged behind the user; anything else is a question', () => {
	// The journal case: the note gained an entry at the end while the user was editing it. Both
	// sets of words are kept, in the order they were written.
	expect(mergeAppend('standup', 'standup, edited', 'standup\n\n14:32 kept')).toBe(
		'standup, edited\n\n14:32 kept'
	)
	// A note that was empty when it was read is the same rule, not a special case.
	expect(mergeAppend('', 'mine', 'theirs')).toBe('minetheirs')
	// Nothing was appended (the base is intact and nothing follows it): the user's words stand.
	expect(mergeAppend('same', 'mine', 'same')).toBe('mine')
	// Rewritten, edited in the middle, or truncated — the change is not something this can
	// reconstruct, so it does not try. `null` is the answer that reaches the user.
	expect(mergeAppend('standup', 'standup, edited', 'rewritten from the top')).toBe(null)
	expect(mergeAppend('one\ntwo', 'one\ntwo, edited', 'one\nEDITED\ntwo')).toBe(null)
	expect(mergeAppend('one\ntwo', 'one\ntwo, edited', 'one')).toBe(null)
})

test('the kept words are taken out by MAPPED offsets, so the right copy goes', () => {
	// Filing is a round trip and the user can type through it, so neither offsets nor content
	// are safe alone: offsets describe a text that no longer exists, and content picks the
	// FIRST match — which is the wrong one when the kept words appear twice.

	// Nothing typed: exactly the selection.
	expect(cutKept('one\ntwo', 'one\ntwo', 4, 7)).toBe('one\n')
	// Typed AFTER the kept words (the common case): the offsets still hold, and the new
	// keystrokes survive — before this rule they were deleted by the stale remainder.
	expect(cutKept('a thought', 'a thought and a newer one', 0, 0)).toBe(' and a newer one')
	// Typed BEFORE the kept words: they moved, so the offsets are shifted by the difference.
	expect(cutKept('keep me', 'new stuff keep me', 0, 4)).toBe('new stuff  me')
	// THE DUPLICATE CASE: the SECOND `todo` was selected and a character typed at the end.
	// Content alone would cut the first one, mangling an entry the gesture never touched.
	expect(cutKept('todo\ntodo', 'todo\ntodox', 5, 9)).toBe('todo\nx')
	// …and the first one selected instead, same edit.
	expect(cutKept('todo\ntodo', 'todo\ntodox', 0, 5)).toBe('todox')
	// The kept words themselves were edited while in flight: nothing can honestly be removed,
	// so nothing is. Two copies are recoverable; the wrong cut is not.
	expect(cutKept('a thought', 'rewritten entirely', 0, 0)).toBe(null)
	// A SECOND copy typed after the kept words does not confuse it either: the offsets say
	// which one was meant, so the one that was there goes and the new one stays.
	expect(cutKept('todo', 'todo\ntodo', 0, 4)).toBe('\ntodo')
	// When the edit DOES overlap the kept words, content is the only evidence left — and it is
	// used only while it is unambiguous. Here the words moved and survived intact.
	expect(cutKept('hello world', 'say hello world', 0, 5)).toBe('say  world')
	// An empty selection of an empty buffer keeps nothing.
	expect(cutKept('', '', 0, 0)).toBe(null)
})
