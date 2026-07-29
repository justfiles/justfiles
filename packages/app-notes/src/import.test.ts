import { expect, test } from 'vitest'
import {
	admit,
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

// The screen witnesses the layout as members stream past, so a root is asserted by
// showing it the members — junk and config included, which is the whole point.
const layoutOf = (members: Array<[string, 'note' | 'junk' | 'config' | 'folder']>) => {
	const screen = createScreen()
	for (const [path, kind] of members) {
		if (kind === 'note') screen.charge(path, 10)
		else if (kind === 'folder') screen.ignore(path)
		else screen.skip(path, kind === 'junk' ? 'junk' : 'config')
	}
	return screen.root
}

test('the vault root is read from the archive LAYOUT, not from the notes we kept', () => {
	// A vault zipped on the desktop: one folder, everything under it.
	expect(
		layoutOf([
			['MyVault/a.md', 'note'],
			['MyVault/Notes/b.md', 'note']
		])
	).toBe('MyVault')
	// macOS adds `__MACOSX/` beside it. Packaging is not evidence, so the root stands.
	expect(
		layoutOf([
			['MyVault/a.md', 'note'],
			['__MACOSX/', 'folder'],
			['__MACOSX/MyVault/._a.md', 'junk']
		])
	).toBe('MyVault')
	// A vault's CONTENTS zipped: `.obsidian/` sits beside the user's own folder, so
	// `Trips` is a folder they made — flattening it would silently restructure the KB.
	expect(
		layoutOf([
			['.obsidian/app.json', 'config'],
			['Trips/Kyoto.md', 'note']
		])
	).toBe('')
	// Two real folders, or anything at the archive root, means nothing to strip.
	expect(
		layoutOf([
			['MyVault/a.md', 'note'],
			['Other/b.md', 'note']
		])
	).toBe('')
	expect(
		layoutOf([
			['a.md', 'note'],
			['MyVault/b.md', 'note']
		])
	).toBe('')
	expect(layoutOf([])).toBe('')
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
	expect(plan.examples.map((skip) => skip.reason).sort()).toEqual([
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
	expect(plan.examples).toEqual([{ path: 'Vault/Huge.md', reason: 'attachment' }])
	expect(plan.stopped).toBe(false) // one absurd file is not a ceiling
})

test('a member that could climb out of the volume is not a member', () => {
	// The names in an archive are untrusted. `..` is refused per segment, and so is a
	// backslash — one segment to every check here, two path components to `node:path.join`,
	// which is the whole trick on a host where `\\` separates.
	const plan = planDrop(
		{
			'MyVault/Kyoto.md': bytes('# Kyoto'),
			'MyVault/../../etc/notes/payload.md': bytes('nope'),
			'MyVault/..\\..\\system\\payload.md': bytes('nope'),
			'..\\Kyoto.md': bytes('nope')
		},
		'vault.zip'
	)
	expect(plan.files.map((file) => file.path)).toEqual(['Kyoto.md'])
	expect(plan.skipped).toBe(3)
})

test('a skipped member still describes the archive layout', () => {
	// Which members are interesting and which describe the SHAPE are different questions.
	// A conflicted copy is not worth importing, but the vault put it where it is — and a
	// vault-contents archive with one beside a real folder must not have that folder
	// mistaken for packaging and stripped.
	const plan = planDrop(
		{
			'Trips/Kyoto.md': bytes('# Kyoto'),
			'Kyoto (conflicted copy 2024-01-01).md': bytes('dupe')
		},
		'vault.zip'
	)
	// `Trips/` survives: it is the user's folder, not a wrapper. (The name then comes from
	// the zip, since the archive has no single root folder to take it from.)
	expect(plan.files.map((file) => file.path)).toEqual(['Trips/Kyoto.md'])
	expect(plan.name).toBe('vault')

	// OS packaging is the one exception: the zipper added it, so it says nothing.
	const packaged = planDrop(
		{ 'MyVault/Kyoto.md': bytes('# Kyoto'), '__MACOSX/._MyVault': bytes('junk') },
		'vault.zip'
	)
	expect(packaged.files.map((file) => file.path)).toEqual(['Kyoto.md'])
	expect(packaged.name).toBe('MyVault')
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
	expect(screen.examples.at(-1)?.reason).toBe('too much')
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
	expect(screen.examples).toEqual([{ path: 'Vault/Huge.md', reason: 'attachment' }])
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
	expect(plan.skipped).toBe(0) // neither was lost, so neither is a skip
})

test('an entry the volume would respell is dropped, not sent on to be refused', () => {
	// One odd name in an archive must not cost the user the other thousand notes: it is
	// screened here (and reported) instead of failing the procedure's canonical check.
	const plan = planDrop(
		{
			'vault/Kyoto.md': bytes('Kyoto'),
			'vault//Odd.md': bytes('empty segment'),
			'/vault/Absolute.md': bytes('leading slash')
		},
		'vault.zip'
	)
	expect(plan.files.map((f) => f.path)).toEqual(['Kyoto.md'])
	expect(plan.examples.map((s) => s.reason)).toEqual(['junk', 'junk'])
})

test('an archive of nothing but refusals is bounded too', () => {
	// Neither ceiling above sees these: no bytes are charged and no note is kept, so a
	// zip of a million attachments would be walked to the end and every refusal
	// remembered. The member budget is what makes `stopped` reachable, and the report
	// stays a COUNT plus a sample however many there are.
	const screen = createScreen({ maxMembers: 10 })
	for (let i = 0; i < 400; i++) screen.skip(`Vault/photo-${i}.png`, 'attachment')
	expect(screen.stopped).toBe(true)
	expect(screen.skipped).toBe(400)
	expect(screen.examples.length).toBeLessThanOrEqual(50)
})

test('members are counted whether they are kept, refused or ignored', () => {
	const screen = createScreen({ maxMembers: 3 })
	expect(screen.charge('a.md', 10)).toBe(true)
	screen.skip('b.png', 'attachment')
	// A folder entry produces nothing and reports nothing, but it is still work: an
	// archive of a million empty directories has to reach the ceiling too.
	screen.ignore('vault/folder/')
	expect(screen.stopped).toBe(false)
	expect(screen.skipped).toBe(1)
	const folders = createScreen({ maxMembers: 5 })
	for (let i = 0; i < 40; i++) folders.ignore(`vault/folder-${i}/`)
	expect(folders.stopped).toBe(true)
	expect(folders.skipped).toBe(0)
	expect(screen.charge('c.md', 10)).toBe(false)
	expect(screen.stopped).toBe(true)
})

test('a partial import keeps the shape it saw, instead of stripping a root it guessed', () => {
	// Everything read so far sits under `Trips/`, so the layout SAYS one root — but the
	// stream was abandoned, and the entry at the archive root that would disprove it is
	// among the ones never read. Stripping here would flatten a folder the user made.
	const screen = createScreen({ maxFiles: 2 })
	const kept = [
		{ path: 'Trips/Kyoto.md', bytes: bytes('Kyoto') },
		{ path: 'Trips/Osaka.md', bytes: bytes('Osaka') },
		{ path: 'Trips/Nara.md', bytes: bytes('Nara') }
	].flatMap((entry) => admit(entry, screen) ?? [])
	expect(screen.stopped).toBe(true)
	expect(screen.root).toBe('Trips') // the layout, as far as it was seen
	const plan = planImport(kept, 'vault.zip', screen)
	expect(plan.files.map((f) => f.path)).toEqual(['Trips/Kyoto.md', 'Trips/Osaka.md'])
	expect(plan.stopped).toBe(true)
	// A complete read of the same archive is free to strip it.
	const whole = createScreen()
	const all = [
		{ path: 'Trips/Kyoto.md', bytes: bytes('Kyoto') },
		{ path: 'Trips/Osaka.md', bytes: bytes('Osaka') }
	].flatMap((entry) => admit(entry, whole) ?? [])
	expect(planImport(all, 'vault.zip', whole).files.map((f) => f.path)).toEqual([
		'Kyoto.md',
		'Osaka.md'
	])
})
