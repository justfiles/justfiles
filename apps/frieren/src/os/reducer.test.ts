import { describe, expect, test } from 'vitest'
import { osReducer } from './reducer'
import { initialState, type OsAction, type OsState } from './state'

function run(actions: OsAction[], from: OsState = initialState): OsState {
	return actions.reduce(osReducer, from)
}

describe('osReducer', () => {
	test('open creates a floating window and focuses it', () => {
		const state = run([{ type: 'app.open', appId: 'finder', title: 'Finder' }])
		const window = state.windows.finder
		expect(window).toMatchObject({
			id: 'finder',
			appId: 'finder',
			title: 'Finder',
			mode: 'floating'
		})
		expect(window?.rect).toEqual({ x: 80, y: 40, w: 720, h: 520 })
		expect(state.openOrder).toEqual(['finder'])
		expect(state.focusStack).toEqual(['finder'])
	})

	test('opening multiple apps appends to openOrder and focusStack', () => {
		const state = run([
			{ type: 'app.open', appId: 'a' },
			{ type: 'app.open', appId: 'b' }
		])
		expect(state.openOrder).toEqual(['a', 'b'])
		expect(state.focusStack).toEqual(['a', 'b'])
		expect(state.windows.b?.rect.x).toBe(80 + 24)
	})

	test('reopening a running app only refocuses, never duplicates', () => {
		const state = run([
			{ type: 'app.open', appId: 'a' },
			{ type: 'app.open', appId: 'b' },
			{ type: 'app.open', appId: 'a' }
		])
		expect(state.openOrder).toEqual(['a', 'b'])
		expect(state.focusStack).toEqual(['b', 'a'])
	})

	test('opening the already-focused app is a no-op reference', () => {
		const opened = run([{ type: 'app.open', appId: 'a' }])
		const next = osReducer(opened, { type: 'app.open', appId: 'a' })
		expect(next).toBe(opened)
	})

	test('close removes the window from windows, openOrder, and focusStack', () => {
		const state = run([
			{ type: 'app.open', appId: 'a' },
			{ type: 'app.open', appId: 'b' },
			{ type: 'window.close', id: 'a' }
		])
		expect(state.windows.a).toBeUndefined()
		expect(state.openOrder).toEqual(['b'])
		expect(state.focusStack).toEqual(['b'])
	})

	test('closing an unknown window is a no-op reference', () => {
		const opened = run([{ type: 'app.open', appId: 'a' }])
		expect(osReducer(opened, { type: 'window.close', id: 'missing' })).toBe(opened)
	})

	test('focus moves to the top of focusStack without reordering openOrder', () => {
		const state = run([
			{ type: 'app.open', appId: 'a' },
			{ type: 'app.open', appId: 'b' },
			{ type: 'app.open', appId: 'c' },
			{ type: 'window.focus', id: 'a' }
		])
		expect(state.openOrder).toEqual(['a', 'b', 'c'])
		expect(state.focusStack).toEqual(['b', 'c', 'a'])
	})

	test('focusing the top window is a no-op reference', () => {
		const opened = run([
			{ type: 'app.open', appId: 'a' },
			{ type: 'app.open', appId: 'b' }
		])
		expect(osReducer(opened, { type: 'window.focus', id: 'b' })).toBe(opened)
	})

	test('rect update replaces the rect; an identical rect is a no-op reference', () => {
		const opened = run([{ type: 'app.open', appId: 'a' }])
		const rect = { x: 10, y: 20, w: 400, h: 300 }
		const moved = osReducer(opened, { type: 'window.rectUpdated', id: 'a', rect })
		expect(moved.windows.a?.rect).toEqual(rect)
		expect(osReducer(moved, { type: 'window.rectUpdated', id: 'a', rect: { ...rect } })).toBe(moved)
	})

	test('setMode toggles fullscreen and minimized; a repeat is a no-op reference', () => {
		const full = run([
			{ type: 'app.open', appId: 'a' },
			{ type: 'window.setMode', id: 'a', mode: 'fullscreen' }
		])
		expect(full.windows.a?.mode).toBe('fullscreen')

		const min = osReducer(full, { type: 'window.setMode', id: 'a', mode: 'minimized' })
		expect(min.windows.a?.mode).toBe('minimized')
		expect(osReducer(min, { type: 'window.setMode', id: 'a', mode: 'minimized' })).toBe(min)
	})

	test('boot/loaded overwrites state and forces booted true', () => {
		const snapshot: OsState = {
			version: 1,
			booted: false,
			windows: { a: { id: 'a', appId: 'a', rect: { x: 1, y: 2, w: 3, h: 4 }, mode: 'floating' } },
			openOrder: ['a'],
			focusStack: ['a'],
			chatOpen: true
		}
		const state = osReducer(initialState, { type: 'boot/loaded', state: snapshot })
		expect(state.booted).toBe(true)
		expect(state.openOrder).toEqual(['a'])
		expect(state.chatOpen).toBe(true)
	})

	test('chat.setOpen flips the flag; a repeat is a no-op reference', () => {
		const open = osReducer(initialState, { type: 'chat.setOpen', open: true })
		expect(open.chatOpen).toBe(true)
		expect(osReducer(open, { type: 'chat.setOpen', open: true })).toBe(open)
	})

	test('invariant: openOrder and focusStack ids always resolve to a window, no dups', () => {
		const state = run([
			{ type: 'app.open', appId: 'a' },
			{ type: 'app.open', appId: 'b' },
			{ type: 'app.open', appId: 'c' },
			{ type: 'window.focus', id: 'a' },
			{ type: 'window.close', id: 'b' },
			{ type: 'app.open', appId: 'a' }
		])
		for (const id of [...state.openOrder, ...state.focusStack]) {
			expect(state.windows[id]).toBeDefined()
		}
		expect(new Set(state.openOrder).size).toBe(state.openOrder.length)
		expect(new Set(state.focusStack).size).toBe(state.focusStack.length)
	})
})
