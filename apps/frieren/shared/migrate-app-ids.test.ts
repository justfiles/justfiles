import { memStorage, type Volume, volume } from '@justfiles/fs'
import { beforeEach, describe, expect, test } from 'vitest'
import {
	FIRST_PARTY_APP_ID_RENAMES,
	migrateFirstPartyAppIds
} from '../../shared/migrate-app-ids.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

async function write(fs: Volume, path: string, text: string): Promise<void> {
	await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
	await fs.writeFile(path, enc.encode(text))
}

async function seedApp(fs: Volume, id: string): Promise<void> {
	await write(fs, `/applications/${id}/manifest.json`, JSON.stringify({ id, name: id }))
	await write(fs, `/applications/${id}/app.js`, '// app')
	await write(fs, `/state/${id}.json`, JSON.stringify({ id }))
	await write(fs, `/data/${id}/note.txt`, id)
}

describe('migrateFirstPartyAppIds', () => {
	let fs: Volume

	beforeEach(() => {
		fs = volume(memStorage())
	})

	test('moves app storage and rewrites stored id references', async () => {
		await seedApp(fs, 'app.justfiles.frieren.code')
		await write(
			fs,
			'/system/os-state.json',
			JSON.stringify({ windows: { code: { appId: 'app.justfiles.frieren.code' } } })
		)

		expect(await migrateFirstPartyAppIds(fs)).toBe(true)
		expect(await fs.exists('/applications/app.justfiles.frieren.code')).toBe(false)
		expect(await fs.exists('/state/app.justfiles.frieren.code.json')).toBe(false)
		expect(await fs.exists('/data/app.justfiles.frieren.code')).toBe(false)
		expect(await fs.exists('/applications/justfiles.code')).toBe(true)
		expect(await fs.exists('/state/justfiles.code.json')).toBe(true)
		expect(await fs.exists('/data/justfiles.code')).toBe(true)
		expect(
			JSON.parse(dec.decode(await fs.readFile('/applications/justfiles.code/manifest.json'))).id
		).toBe('justfiles.code')
		expect(JSON.parse(dec.decode(await fs.readFile('/system/os-state.json')))).toEqual({
			windows: { code: { appId: 'justfiles.code' } }
		})
	})

	test('changes nothing when any destination conflicts', async () => {
		await seedApp(fs, 'app.justfiles.frieren.code')
		await seedApp(fs, 'justfiles.code')
		await seedApp(fs, 'app.justfiles.frieren.notes')

		expect(await migrateFirstPartyAppIds(fs)).toBe(false)
		expect(await fs.exists('/applications/app.justfiles.frieren.notes')).toBe(true)
		expect(await fs.exists('/applications/justfiles.notes')).toBe(false)
	})

	test('uses an exact map for every existing first-party app', () => {
		expect(FIRST_PARTY_APP_ID_RENAMES).toEqual(
			[
				'code',
				'crossword',
				'dictionary',
				'doom',
				'draw',
				'files',
				'notes',
				'paint',
				'pixel',
				'settings'
			].map((id) => [`app.justfiles.frieren.${id}`, `justfiles.${id}`])
		)
	})
})
