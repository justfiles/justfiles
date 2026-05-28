import { describe, expect, test } from 'vitest'
import { resolveAppTitle } from './catalog'
import type { InstalledApp } from './types'

const apps: InstalledApp[] = [{ id: 'notes', name: 'Notes', description: '' }]

describe('resolveAppTitle', () => {
	test('derives the title from catalog metadata when available', () => {
		expect(resolveAppTitle(apps, 'notes', 'stale')).toBe('Notes')
	})

	test('falls back to the persisted title when the catalog lacks the app', () => {
		expect(resolveAppTitle([], 'notes', 'Notes (restored)')).toBe('Notes (restored)')
	})

	test('falls back to the appId when neither catalog nor persisted title exist', () => {
		expect(resolveAppTitle([], 'notes')).toBe('notes')
	})
})
