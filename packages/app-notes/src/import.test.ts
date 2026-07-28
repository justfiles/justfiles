import { expect, test } from 'vitest'
import { commonRoot, planImport, screenEntry, vaultName } from './import.ts'

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
	const plan = planImport({ 'Vault/Huge.md': bytes('x'.repeat(50)) }, 'Vault.zip', { maxBytes: 10 })
	expect(plan.files).toEqual([])
	expect(plan.skipped).toEqual([{ path: 'Vault/Huge.md', reason: 'attachment' }])
})

test('loose notes with no wrapping folder keep their names', () => {
	const plan = planImport({ 'hello.md': bytes('42\n'), 'notes.txt': bytes('hi') }, 'Imported')
	expect(plan.name).toBe('Imported')
	expect(plan.files.map((file) => file.path).sort()).toEqual(['hello.md', 'notes.txt'])
	expect(plan.folders).toBe(0)
})

test('an entry can be screened from its header, before it is decompressed', () => {
	// This is what the zip `filter` calls: name + declared original size only, so
	// attachments and absurd files are never inflated into the tab.
	expect(screenEntry('Vault/Kyoto.md', 200)).toBe(null)
	expect(screenEntry('Vault/Attachments/pic.png', 200)).toBe('attachment')
	expect(screenEntry('Vault/.obsidian/app.json', 20)).toBe('config')
	expect(screenEntry('__MACOSX/._Kyoto.md', 20)).toBe('junk')
	// A zip bomb declares its size in the central directory — believe it.
	expect(screenEntry('Vault/Bomb.md', 10_000_000_000)).toBe('attachment')
})

test('entries the caller already rejected are folded into the report', () => {
	const plan = planImport({ 'Vault/Kyoto.md': bytes('x') }, 'Vault.zip', {
		preSkipped: [{ path: 'Vault/Attachments/pic.png', reason: 'attachment' }]
	})
	expect(plan.files.map((file) => file.path)).toEqual(['Kyoto.md'])
	expect(plan.skipped).toEqual([{ path: 'Vault/Attachments/pic.png', reason: 'attachment' }])
	// A pre-skipped attachment must not count as a second root and re-nest the vault.
	expect(plan.name).toBe('Vault')
})
