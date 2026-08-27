import { describe, expect, test } from 'vitest'
import type { Volume } from '../fs'
import { loadSnapshot, serializeOsState } from './persistence'
import { initialAttachedAgentState, type OsState } from './state'

const PATH = '/system/os-state.json'

// Minimal read-only volume: loadSnapshot only calls exists + readFile.
function fakeVolume(files: Record<string, string>): Volume {
	return {
		exists: async (p: string) => p in files,
		readFile: async (p: string) => new TextEncoder().encode(files[p])
	} as unknown as Volume
}

const base: OsState = {
	version: 1,
	booted: true,
	windows: { files: { id: 'files', kind: 'app', appId: 'files', mode: 'floating' } },
	openOrder: ['files'],
	focusStack: ['files'],
	placements: { files: { x: 10, y: 20, w: 300, h: 200 } },
	assistant: initialAttachedAgentState
}

describe('serializeOsState', () => {
	// Back-compat: a still-cached pre-placements client reads geometry from
	// window.rect and accepts version 1, so each open window must keep carrying
	// its placement as rect or that client crashes on restore.
	test('mirrors each open window placement onto window.rect for v1 readers', () => {
		const parsed = JSON.parse(serializeOsState(base))
		expect(parsed.windows.files.rect).toEqual({ x: 10, y: 20, w: 300, h: 200 })
		expect(parsed.placements.files).toEqual({ x: 10, y: 20, w: 300, h: 200 })
	})

	test('drops ephemeral (.-prefixed) windows and their placement', () => {
		const parsed = JSON.parse(
			serializeOsState({
				...base,
				windows: {
					...base.windows,
					'.preview.x': { id: '.preview.x', kind: 'app', appId: '.preview.x', mode: 'floating' }
				},
				openOrder: ['files', '.preview.x'],
				focusStack: ['files', '.preview.x'],
				placements: { ...base.placements, '.preview.x': { x: 0, y: 0, w: 1, h: 1 } }
			})
		)
		expect(parsed.windows['.preview.x']).toBeUndefined()
		expect(parsed.placements['.preview.x']).toBeUndefined()
		expect(parsed.openOrder).toEqual(['files'])
	})

	test('drops ephemeral attached panels', () => {
		const parsed = JSON.parse(
			serializeOsState({
				...base,
				assistant: {
					...base.assistant,
					open: { files: true, '.preview.x': true }
				}
			})
		)
		expect(parsed.assistant.open).toEqual({ files: true })
	})
})

describe('loadSnapshot', () => {
	test('lifts a legacy per-window rect into placements and drops rect', async () => {
		const legacy = JSON.stringify({
			version: 1,
			booted: false,
			windows: {
				files: {
					id: 'files',
					kind: 'app',
					appId: 'files',
					rect: { x: 1, y: 2, w: 3, h: 4 },
					mode: 'floating'
				}
			},
			openOrder: ['files'],
			focusStack: ['files']
		})
		const state = await loadSnapshot(fakeVolume({ [PATH]: legacy }))
		expect(state.placements.files).toEqual({ x: 1, y: 2, w: 3, h: 4 })
		expect((state.windows.files as { rect?: unknown }).rect).toBeUndefined()
		expect(state.assistant).toEqual(initialAttachedAgentState)
	})

	test('round-trips a placements snapshot without clobbering placements', async () => {
		const state = await loadSnapshot(fakeVolume({ [PATH]: serializeOsState(base) }))
		expect(state.placements.files).toEqual({ x: 10, y: 20, w: 300, h: 200 })
		expect((state.windows.files as { rect?: unknown }).rect).toBeUndefined()
	})

	test('missing file falls back to a fresh state with empty placements', async () => {
		const state = await loadSnapshot(fakeVolume({}))
		expect(state.placements).toEqual({})
		expect(state.openOrder).toEqual([])
	})
})
