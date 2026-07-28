import { expect, test } from 'vitest'
import {
	displayPath,
	illegalMove,
	isUnder,
	matchNotes,
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
	expect(renameTarget('/Trips/Kyoto.md', '/Trips/Kyoto 2023')).toBe('/Trips/Kyoto 2023.md')
	expect(renameTarget('/Old.txt', '/New')).toBe('/New.txt')
	// An explicit extension is respected, and folders are left alone.
	expect(renameTarget('/Kyoto.md', '/Kyoto.txt')).toBe('/Kyoto.txt')
	expect(renameTarget('/Trips', '/Travel')).toBe('/Travel')
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
