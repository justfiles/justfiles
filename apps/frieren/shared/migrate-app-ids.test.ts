import { memStorage, type Volume, volume } from '@justfiles/fs'
import { beforeEach, describe, expect, test } from 'vitest'
import { APP_ID_MIGRATION_V1, migrateAppIdsOnce, runAppIdMigrationV1 } from './migrate-app-ids.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

async function write(vol: Volume, path: string, text: string): Promise<void> {
	const i = path.lastIndexOf('/')
	if (i > 0) await vol.mkdir(path.slice(0, i), { recursive: true })
	await vol.writeFile(path, enc.encode(text))
}

async function read(vol: Volume, path: string): Promise<string> {
	return dec.decode(await vol.readFile(path))
}

// Seed one app's full layout: bundle+manifest, state, and a data file.
async function seedApp(vol: Volume, id: string): Promise<void> {
	await write(
		vol,
		`/applications/${id}/manifest.json`,
		JSON.stringify({ id, name: id, version: '1' })
	)
	await write(vol, `/applications/${id}/app.js`, `// ${id}`)
	await write(vol, `/state/${id}.json`, JSON.stringify({ hello: id }))
	await write(vol, `/data/${id}/note.txt`, `data for ${id}`)
}

function osState(...appIds: string[]): string {
	const windows: Record<string, { appId: string }> = {}
	appIds.forEach((id, i) => {
		windows[`w${i}`] = { appId: id }
	})
	return JSON.stringify({
		windows,
		focusStack: appIds.map((_, i) => `w${i}`),
		openOrder: appIds.map((_, i) => `w${i}`),
		// A "map"/placement keyed by app id — must be rewritten too.
		placements: Object.fromEntries(appIds.map((id) => [id, { x: 0 }]))
	})
}

describe('runAppIdMigrationV1', () => {
	let vol: Volume
	beforeEach(() => {
		vol = volume(memStorage())
	})

	test('dry run reports sources and mutates nothing', async () => {
		await seedApp(vol, 'computer.spud.code')
		await seedApp(vol, 'computer.spud.files')

		const result = await runAppIdMigrationV1(vol, { dryRun: true })

		expect(result.dryRun).toBe(true)
		expect(result.conflict).toBe(false)
		const code = result.entries.find((e) => e.oldId === 'computer.spud.code')
		expect(code?.sources).toEqual([
			'/applications/computer.spud.code',
			'/state/computer.spud.code.json',
			'/data/computer.spud.code'
		])
		expect(code?.moved).toEqual([])
		expect(await vol.exists('/applications/computer.spud.code')).toBe(true)
		expect(await vol.exists('/applications/app.justfiles.frieren.code')).toBe(false)
	})

	test('real run moves the layout (atomic rename) and rewrites the manifest id', async () => {
		await seedApp(vol, 'computer.spud.code')

		const result = await runAppIdMigrationV1(vol, { dryRun: false })

		expect(result.conflict).toBe(false)
		// Old gone, new present.
		expect(await vol.exists('/applications/computer.spud.code')).toBe(false)
		expect(await vol.exists('/state/computer.spud.code.json')).toBe(false)
		expect(await vol.exists('/data/computer.spud.code')).toBe(false)
		expect(await vol.exists('/applications/app.justfiles.frieren.code')).toBe(true)
		expect(await vol.exists('/state/app.justfiles.frieren.code.json')).toBe(true)
		expect(await read(vol, '/data/app.justfiles.frieren.code/note.txt')).toContain(
			'computer.spud.code'
		)
		const manifest = JSON.parse(
			await read(vol, '/applications/app.justfiles.frieren.code/manifest.json')
		)
		expect(manifest.id).toBe('app.justfiles.frieren.code')
		// No backup artifact is left behind (PITR is the recovery net).
		expect(await vol.exists('/system/migration-backups')).toBe(false)
	})

	test('rewrites every os-state id reference (values and keys)', async () => {
		await seedApp(vol, 'computer.spud.code')
		await seedApp(vol, 'computer.spud.paint')
		await write(vol, '/system/os-state.json', osState('computer.spud.code', 'computer.spud.paint'))

		const result = await runAppIdMigrationV1(vol, { dryRun: false })

		const text = await read(vol, '/system/os-state.json')
		expect(text).not.toContain('computer.spud.')
		const parsed = JSON.parse(text)
		expect(parsed.windows.w0.appId).toBe('app.justfiles.frieren.code')
		expect(parsed.placements['app.justfiles.frieren.paint']).toEqual({ x: 0 })
		// 2 ids x 2 occurrences each (window appId + placement key) = 4.
		expect(result.osStateRewrites).toBe(4)
	})

	test('aborts the whole run on any conflict, mutating nothing', async () => {
		await seedApp(vol, 'computer.spud.code')
		await seedApp(vol, 'app.justfiles.frieren.code') // destination already exists
		await seedApp(vol, 'computer.spud.paint')

		const result = await runAppIdMigrationV1(vol, { dryRun: false })

		expect(result.conflict).toBe(true)
		const code = result.entries.find((e) => e.oldId === 'computer.spud.code')
		expect(code?.conflicts).toContain('/applications/app.justfiles.frieren.code')
		// Nothing moved — even the non-conflicting app is left untouched.
		expect(await vol.exists('/applications/computer.spud.paint')).toBe(true)
		expect(await vol.exists('/applications/app.justfiles.frieren.paint')).toBe(false)
	})

	test('is an idempotent no-op once nothing legacy remains', async () => {
		await seedApp(vol, 'app.justfiles.frieren.code')
		await write(vol, '/system/os-state.json', osState('app.justfiles.frieren.code'))

		const result = await runAppIdMigrationV1(vol, { dryRun: false })

		expect(result.conflict).toBe(false)
		expect(result.osStateRewrites).toBe(0)
		expect(result.entries.every((e) => e.sources.length === 0)).toBe(true)
		expect(await vol.exists('/applications/app.justfiles.frieren.code')).toBe(true)
	})

	test('map is exact old->new, never a prefix rule', () => {
		for (const [oldId, newId] of APP_ID_MIGRATION_V1) {
			expect(oldId.startsWith('computer.spud.')).toBe(true)
			expect(newId.startsWith('app.justfiles.frieren.')).toBe(true)
			expect(oldId.slice('computer.spud.'.length)).toBe(
				newId.slice('app.justfiles.frieren.'.length)
			)
		}
	})

	test('migrateAppIdsOnce collapses concurrent + repeat calls onto one run per volume', async () => {
		await seedApp(vol, 'computer.spud.code')
		const a = migrateAppIdsOnce(vol)
		expect(migrateAppIdsOnce(vol)).toBe(a) // same in-flight promise
		await a
		expect(migrateAppIdsOnce(vol)).toBe(a) // memoised after completion — no second move
		expect(await vol.exists('/applications/app.justfiles.frieren.code')).toBe(true)
		expect(await vol.exists('/applications/computer.spud.code')).toBe(false)
	})
})
