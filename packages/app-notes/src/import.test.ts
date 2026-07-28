import { expect, test } from 'vitest'
import {
	admit,
	commonRoot,
	createScreen,
	MAX_FILES,
	MAX_TOTAL_BYTES,
	planImport,
	screenEntry,
	vaultName
} from './import.ts'

const enc = new TextEncoder()
const bytes = (text: string) => enc.encode(text)
// The planner takes a LIST (two loose files can share a basename); these tests are
// written as maps for readability where the paths happen to be unique.
const entries = (map: Record<string, Uint8Array>) =>
	Object.entries(map).map(([path, data]) => ({ path, bytes: data }))
// The whole pipeline, as both readers run it: judge and CHARGE each entry whose
// bytes are in hand (`admit`), then plan the survivors. `planImport` is structure
// only, so a test that wants the rules applied has to go through `admit` too.
const planDrop = (map: Record<string, Uint8Array>, zipName: string, screen = createScreen()) =>
	planImport(
		entries(map).flatMap((entry) => admit(entry, screen) ?? []),
		zipName,
		screen
	)

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
	const plan = planDrop(
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
	const plan = planDrop({ 'Vault/Kyo\u0304to.md': bytes('x') }, 'Vault.zip')
	expect(plan.files[0]?.path).toBe('Kyōto.md'.normalize('NFC'))
	expect(plan.files[0]?.path.normalize('NFD')).not.toBe(plan.files[0]?.path)
})

test('an oversized file is reported rather than pulled into memory-sized batches', () => {
	const screen = createScreen()
	const entry = { path: 'Vault/Huge.md', bytes: bytes('x'.repeat(50)) }
	expect(admit(entry, screen, 10)).toBe(null)
	const plan = planImport([], 'Vault.zip', screen)
	expect(plan.files).toEqual([])
	expect(plan.skipped).toEqual([{ path: 'Vault/Huge.md', reason: 'attachment' }])
	expect(plan.stopped).toBe(false) // one absurd file is not a ceiling
})

test('loose notes with no wrapping folder keep their names', () => {
	const plan = planDrop({ 'hello.md': bytes('42\n'), 'notes.txt': bytes('hi') }, 'Imported')
	expect(plan.name).toBe('Imported')
	expect(plan.files.map((file) => file.path).sort()).toEqual(['hello.md', 'notes.txt'])
	expect(plan.folders).toBe(0)
})

test('an entry is judged from its name and its declared size, before it is read', () => {
	// The cheap pre-check both readers run: a zip entry's local header, or a loose
	// `File.size`. Pure, and it charges nothing — a declared size is only a claim.
	expect(screenEntry('Vault/Kyoto.md', 200)).toBe(null)
	expect(screenEntry('Vault/Attachments/pic.png', 200)).toBe('attachment')
	expect(screenEntry('Vault/.obsidian/app.json', 20)).toBe('config')
	expect(screenEntry('__MACOSX/._Kyoto.md', 20)).toBe('junk')
	// A zip bomb that declares its size is refused on the claim alone.
	expect(screenEntry('Vault/Bomb.md', 10_000_000_000)).toBe('attachment')
})

test('the whole drop is bounded, not just each entry', () => {
	// Every one of these is a legal note on its own; together they are the 4 GB that
	// kills the tab. The ceiling has to be on the SUM.
	const screen = createScreen()
	const each = 4_000_000
	let charged = 0
	for (let i = 0; i < 100; i++) if (screen.charge(`Vault/Note ${i}.md`, each)) charged++
	expect(charged).toBe(Math.floor(MAX_TOTAL_BYTES / each))
	expect(screen.stopped).toBe(true)
	expect(screen.skipped.at(-1)?.reason).toBe('too much')
})

test('the file count is bounded too, for a drop of tiny notes', () => {
	const screen = createScreen()
	let charged = 0
	for (let i = 0; i < MAX_FILES + 10; i++) if (screen.charge(`n${i}.md`, 1)) charged++
	expect(charged).toBe(MAX_FILES)
	expect(screen.stopped).toBe(true)
})

test('the budget is charged the bytes an entry HAS, not the size it claimed', () => {
	// A streamed archive may declare nothing at all: every entry then sails through
	// the header pre-check with a claimed size of 0. If that claim were what got
	// charged, the ceiling would never arrive and every buffer would stay in memory —
	// which is the whole thing the ceiling exists to prevent.
	const screen = createScreen({ maxTotalBytes: 30 })
	const kept = []
	for (let i = 0; i < 10; i++) {
		expect(screenEntry(`Vault/Note ${i}.md`, 0)).toBe(null) // claims nothing, passes
		const entered = admit({ path: `Vault/Note ${i}.md`, bytes: bytes('0123456789') }, screen)
		if (entered) kept.push(entered)
	}
	expect(kept).toHaveLength(3) // 3 × 10 real bytes = 30
	expect(screen.stopped).toBe(true)
})

test('two entries sharing a path each cost their own bytes', () => {
	// Same-named files from different folders are a real drop, and charging only the
	// first would let a duplicate-heavy drop past both ceilings for free.
	const screen = createScreen({ maxTotalBytes: 15 })
	expect(admit({ path: 'Kyoto.md', bytes: bytes('0123456789') }, screen)).not.toBe(null)
	expect(admit({ path: 'Kyoto.md', bytes: bytes('0123456789') }, screen)).toBe(null)
	expect(screen.stopped).toBe(true)
})

test('a refusal found mid-inflate is reported like any other skip', () => {
	// An entry that declared nothing and then outgrew the per-entry cap is only
	// discovered while streaming it; the reader reports it and drops the buffer.
	const screen = createScreen()
	screen.skip('Vault/Huge.md', 'attachment')
	expect(screen.skipped).toEqual([{ path: 'Vault/Huge.md', reason: 'attachment' }])
})

test('two loose notes with the same name both survive planning', () => {
	// Dropped from different folders, so both are called "Kyoto.md". A map keyed by
	// path would keep the last and report a clean success — the write side is what
	// numbers the second one, and it can only do that if planning hands it both.
	const plan = planImport(
		[
			{ path: 'Kyoto.md', bytes: bytes('first') },
			{ path: 'Kyoto.md', bytes: bytes('second') }
		],
		'Imported'
	)
	expect(plan.files).toEqual([
		{ path: 'Kyoto.md', text: 'first' },
		{ path: 'Kyoto.md', text: 'second' }
	])
	expect(plan.skipped).toEqual([]) // neither was lost, so neither is a skip
})
