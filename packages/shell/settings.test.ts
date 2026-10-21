import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSettings, volumeRoot } from './settings.ts'

describe('readSettings', () => {
	it('is empty without a settings.json, and the file when there is one', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ghost-settings-'))
		try {
			expect(readSettings(dir)).toEqual({})
			await writeFile(join(dir, 'settings.json'), '{ "root": "/Volumes/files" }')
			expect(readSettings(dir)).toEqual({ root: '/Volumes/files' })
		} finally {
			await rm(dir, { recursive: true })
		}
	})
})

describe('volumeRoot', () => {
	it('is ~/files when the settings name none', () => {
		expect(volumeRoot({})).toBe(join(homedir(), 'files'))
	})

	it('expands ~ and keeps an absolute root', () => {
		expect(volumeRoot({ root: '~/other' })).toBe(join(homedir(), 'other'))
		expect(volumeRoot({ root: '/Volumes/files' })).toBe('/Volumes/files')
	})
})
