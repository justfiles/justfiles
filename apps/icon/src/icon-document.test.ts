import { describe, expect, it } from 'vitest'
import {
	DEFAULT_ICON_SETTINGS,
	ICON_BOUNDS,
	iconExportScale,
	iconSettingsOf,
	withIconSettings
} from './icon-document.ts'

describe('icon document', () => {
	it('defines a centred 1024px output frame', () => {
		expect(ICON_BOUNDS).toEqual({ x: -512, y: -512, width: 1024, height: 1024 })
	})

	it('scales a 20-unit viewport window to the full 1024px output', () => {
		expect(iconExportScale({ x: 0, y: 0, size: 20 })).toBe(51.2)
	})

	it('round-trips icon settings through otherwise-valid Excalidraw JSON', () => {
		const settings = {
			exportBackground: true,
			grid: true,
			camera: { x: 12.5, y: -8, size: 20 }
		}
		const json = withIconSettings('{"type":"excalidraw","elements":[]}', settings)
		const document = JSON.parse(json) as unknown

		expect(iconSettingsOf(document)).toEqual(settings)
		expect(document).toMatchObject({ type: 'excalidraw', elements: [] })
	})

	it('uses transparent export for old or malformed documents', () => {
		expect(iconSettingsOf({})).toEqual(DEFAULT_ICON_SETTINGS)
		expect(
			iconSettingsOf({ icon: { exportBackground: 'yes', camera: { x: 0, y: 0, size: -1 } } })
		).toEqual(DEFAULT_ICON_SETTINGS)
		expect(iconSettingsOf({ icon: { exportBackground: true } })).toEqual({
			...DEFAULT_ICON_SETTINGS,
			exportBackground: true
		})
	})
})
