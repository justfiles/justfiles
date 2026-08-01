import { expect, test } from 'vitest'
import {
	displayPath,
	draftSurvives,
	failedWith,
	illegalMove,
	illegalName,
	isCanonicalPath,
	isUnder,
	matchNotes,
	namesEntry,
	noteTitle,
	renameTarget,
	sanitizeName
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
