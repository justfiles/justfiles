import { expect, test } from 'vitest'
import {
	commonRoot,
	createScreen,
	MAX_FILES,
	MAX_TOTAL_BYTES,
	planImport,
	vaultName
} from './import.ts'

const enc = new TextEncoder()
const bytes = (text: string) => enc.encode(text)

test('a single shared top folder is the vault root; anything else is not', () => {
	expect(commonRoot(['MyVault/a.md', 'MyVault/Notes/b.md'])).toBe('MyVault')
	expect(commonRoot(['MyVault/a.md', 'Other/b.md'])).toBe('')
	// A file at the archive root means there is no wrapping folder to strip.
	expect(commonRoot(['a.md', 'MyVault/b.md'])).toBe('')
	expect(commonRoot([])).toBe('')
})

test('the vault folder name comes from its own root folder, else the archive', () => {
	expect(vaultName('Obsidian export.zip', 'MyVault')).toBe('MyVault')
	expect(vaultName('MyVault.zip', '')).toBe('MyVault')
	expect(vaultName('archive.tar.gz', '')).toBe('archive.tar')
	expect(vaultName('', '')).toBe('Imported')
})

test('planning an export keeps the notes, the structure, and nothing else', () => {
	const plan = planImport(
		{
			'MyVault/Kyoto.md': bytes('# Kyoto'),
			'MyVault/Trips/Japan/Osaka.md': bytes('Osaka'),
			'MyVault/Groceries.txt': bytes('eggs'),
			// Config, caches and OS junk.
			'MyVault/.obsidian/app.json': bytes('{}'),
			'MyVault/.obsidian/plugins/x/main.js': bytes('//'),
			'MyVault/.trash/Deleted.md': bytes('gone'),
			'MyVault/.DS_Store': bytes('junk'),
			'__MACOSX/._Kyoto.md': bytes('junk'),
			'MyVault/Kyoto (conflicted copy 2024-01-01).md': bytes('dupe'),
			// Real content we can't carry over a JSON-safe seam (reported, not hidden).
			'MyVault/Attachments/Engelbart.jpg': bytes('binary'),
			'MyVault/Board.canvas': bytes('{}'),
			// Directory entries carry nothing; folders come from their children.
			'MyVault/Trips/': bytes('')
		},
		'Obsidian export.zip'
	)

	expect(plan.name).toBe('MyVault')
	expect(plan.files.map((file) => file.path).sort()).toEqual([
		'Groceries.txt',
		'Kyoto.md',
		'Trips/Japan/Osaka.md'
	])
	expect(plan.files.find((file) => file.path === 'Kyoto.md')?.text).toBe('# Kyoto')
	expect(plan.folders).toBe(2) // Trips, Trips/Japan
	expect(plan.skipped.map((skip) => skip.reason).sort()).toEqual([
		'attachment',
		'attachment',
		'config',
		'config',
		'config',
		'junk',
		'junk',
		'junk'
	])
})

test('macOS decomposed filenames are normalized, so they stop looking duplicated', () => {
	// "Kyōto" as NFD (o + combining macron) must land as NFC.
	const plan = planImport({ 'Vault/Kyo\u0304to.md': bytes('x') }, 'Vault.zip')
	expect(plan.files[0]?.path).toBe('Kyōto.md'.normalize('NFC'))
	expect(plan.files[0]?.path.normalize('NFD')).not.toBe(plan.files[0]?.path)
})

test('an oversized file is reported rather than pulled into memory-sized batches', () => {
	const plan = planImport({ 'Vault/Huge.md': bytes('x'.repeat(50)) }, 'Vault.zip', {
		screen: createScreen(10)
	})
	expect(plan.files).toEqual([])
	expect(plan.skipped).toEqual([{ path: 'Vault/Huge.md', reason: 'attachment' }])
	expect(plan.stopped).toBe(false) // one absurd file is not a ceiling
})

test('loose notes with no wrapping folder keep their names', () => {
	const plan = planImport({ 'hello.md': bytes('42\n'), 'notes.txt': bytes('hi') }, 'Imported')
	expect(plan.name).toBe('Imported')
	expect(plan.files.map((file) => file.path).sort()).toEqual(['hello.md', 'notes.txt'])
	expect(plan.folders).toBe(0)
})

test('an entry is judged from its header, before it is decompressed', () => {
	// This is what the zip `filter` calls: name + declared original size only, so
	// attachments and absurd files are never inflated into the tab.
	const screen = createScreen()
	expect(screen.accept('Vault/Kyoto.md', 200)).toBe(true)
	expect(screen.accept('Vault/Attachments/pic.png', 200)).toBe(false)
	expect(screen.accept('Vault/.obsidian/app.json', 20)).toBe(false)
	expect(screen.accept('__MACOSX/._Kyoto.md', 20)).toBe(false)
	// A zip bomb declares its size in the central directory — believe it.
	expect(screen.accept('Vault/Bomb.md', 10_000_000_000)).toBe(false)
	expect(screen.skipped.map((skip) => skip.reason)).toEqual([
		'attachment',
		'config',
		'junk',
		'attachment'
	])
})

test('the whole archive is bounded, not just each entry', () => {
	// Every one of these is a legal note on its own; together they are the 4 GB
	// that kills the tab. The ceiling has to be on the SUM.
	const screen = createScreen()
	const each = 4_000_000
	let accepted = 0
	for (let i = 0; i < 100; i++) if (screen.accept(`Vault/Note ${i}.md`, each)) accepted++
	expect(accepted).toBe(Math.floor(MAX_TOTAL_BYTES / each))
	expect(screen.stopped).toBe(true)
	expect(screen.skipped.at(-1)?.reason).toBe('too much')
})

test('the file count is bounded too, for an archive of tiny notes', () => {
	const screen = createScreen()
	let accepted = 0
	for (let i = 0; i < MAX_FILES + 10; i++) if (screen.accept(`n${i}.md`, 1)) accepted++
	expect(accepted).toBe(MAX_FILES)
	expect(screen.stopped).toBe(true)
})

test('one screen spans the whole drop, and answering twice is free', () => {
	// The zip filter and `planImport` both ask about the same entry: the second ask
	// must not charge the budget again, or a plan would appear to be twice its size.
	const screen = createScreen()
	expect(screen.accept('Vault/Kyoto.md', 10)).toBe(true)
	expect(screen.accept('Vault/Kyoto.md', 10)).toBe(true)
	expect(screen.accept('Vault/Attachments/pic.png', 10)).toBe(false)
	expect(screen.accept('Vault/Attachments/pic.png', 10)).toBe(false)
	expect(screen.skipped).toHaveLength(1) // reported once, not once per ask
	const plan = planImport({ 'Vault/Kyoto.md': bytes('x') }, 'Vault.zip', { screen })
	expect(plan.files.map((file) => file.path)).toEqual(['Kyoto.md'])
	// The screen's own refusals ride along in the report…
	expect(plan.skipped).toEqual([{ path: 'Vault/Attachments/pic.png', reason: 'attachment' }])
	// …and must not count as a second root, which would re-nest the vault.
	expect(plan.name).toBe('Vault')
})
