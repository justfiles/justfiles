import { describe, expect, test } from 'vitest'
import { osReducer } from './reducer'
import { AGENT_WINDOW_ID, initialState, type OsAction, type OsState } from './state'

function run(actions: OsAction[], from: OsState = initialState): OsState {
	return actions.reduce(osReducer, from)
}

describe('osReducer', () => {
	test('open creates a floating window and focuses it', () => {
		const state = run([{ type: 'app.open', appId: 'files', title: 'Files' }])
		const window = state.windows.files
		expect(window).toMatchObject({
			id: 'files',
			appId: 'files',
			title: 'Files',
			mode: 'floating'
		})
		expect(state.placements.files).toEqual({ x: 80, y: 40, w: 720, h: 520 })
		expect(state.openOrder).toEqual(['files'])
		expect(state.focusStack).toEqual(['files'])
	})

	test('opening multiple apps appends to openOrder and focusStack', () => {
		const state = run([
			{ type: 'app.open', appId: 'a' },
			{ type: 'app.open', appId: 'b' }
		])
		expect(state.openOrder).toEqual(['a', 'b'])
		expect(state.focusStack).toEqual(['a', 'b'])
		expect(state.placements.b?.x).toBe(80 + 24)
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

	test('a remote open for an already-open window is a no-op and never refocuses', () => {
		// 'a' is below 'b' in the focus stack. A server echo of its open must not
		// steal focus from 'b'.
		const opened = run([
			{ type: 'app.open', appId: 'a' },
			{ type: 'app.open', appId: 'b' }
		])
		const next = osReducer(opened, { type: 'app.open', appId: 'a', remote: true })
		expect(next).toBe(opened)
		expect(next.focusStack).toEqual(['a', 'b'])
	})

	test('a remote open for a window we have not restored still opens it', () => {
		const state = osReducer(initialState, { type: 'app.open', appId: 'a', remote: true })
		expect(state.windows.a).toMatchObject({ id: 'a', appId: 'a' })
		expect(state.openOrder).toEqual(['a'])
		expect(state.focusStack).toEqual(['a'])
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

	test('close keeps the placement so a relaunch resumes its position/size', () => {
		const rect = { x: 300, y: 120, w: 640, h: 480 }
		const afterClose = run([
			{ type: 'app.open', appId: 'a' },
			{ type: 'window.rectUpdated', id: 'a', rect },
			{ type: 'window.close', id: 'a' }
		])
		expect(afterClose.windows.a).toBeUndefined()
		expect(afterClose.placements.a).toEqual(rect)
		// Reopening reuses the remembered placement instead of the cascade default.
		const reopened = osReducer(afterClose, { type: 'app.open', appId: 'a' })
		expect(reopened.placements.a).toEqual(rect)
	})

	test('rect update replaces the placement; an identical rect is a no-op reference', () => {
		const opened = run([{ type: 'app.open', appId: 'a' }])
		const rect = { x: 10, y: 20, w: 400, h: 300 }
		const moved = osReducer(opened, { type: 'window.rectUpdated', id: 'a', rect })
		expect(moved.placements.a).toEqual(rect)
		expect(osReducer(moved, { type: 'window.rectUpdated', id: 'a', rect: { ...rect } })).toBe(moved)
	})

	test('rect update for a closed window is a no-op reference', () => {
		const opened = run([{ type: 'app.open', appId: 'a' }])
		expect(
			osReducer(opened, {
				type: 'window.rectUpdated',
				id: 'missing',
				rect: { x: 0, y: 0, w: 1, h: 1 }
			})
		).toBe(opened)
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
			windows: {
				a: { id: 'a', kind: 'app', appId: 'a', mode: 'floating' }
			},
			openOrder: ['a'],
			focusStack: ['a'],
			placements: { a: { x: 1, y: 2, w: 3, h: 4 } },
			assistant: initialState.assistant
		}
		const state = osReducer(initialState, { type: 'boot/loaded', state: snapshot })
		expect(state.booted).toBe(true)
		expect(state.openOrder).toEqual(['a'])
	})

	test('updates attached-agent size and restored sidebar windows', () => {
		const sized = run([
			{ type: 'assistant.setSize', size: { sheet: 260, sidebar: 340 } },
			{ type: 'assistant.setOpen', id: 'a', open: true }
		])
		expect(sized.assistant).toEqual({
			size: { sheet: 260, sidebar: 340 },
			open: { a: true }
		})
		expect(
			osReducer(sized, { type: 'assistant.setOpen', id: 'a', open: false }).assistant.open
		).toEqual({})
	})

	test('agent.openWindow creates the singleton conversation window', () => {
		const state = osReducer(initialState, { type: 'agent.openWindow' })
		const window = state.windows[AGENT_WINDOW_ID]
		expect(window).toMatchObject({ id: AGENT_WINDOW_ID, kind: 'agent', mode: 'floating' })
		expect(window?.appId).toBeUndefined()
		expect(state.openOrder).toEqual([AGENT_WINDOW_ID])
		expect(state.focusStack).toEqual([AGENT_WINDOW_ID])
	})

	test('agent.openWindow on an open window refocuses, never duplicates', () => {
		const state = run([
			{ type: 'agent.openWindow' },
			{ type: 'app.open', appId: 'a' },
			{ type: 'agent.openWindow' }
		])
		expect(state.openOrder).toEqual([AGENT_WINDOW_ID, 'a'])
		expect(state.focusStack).toEqual(['a', AGENT_WINDOW_ID])
	})

	test('agent.openWindow on the focused window is a no-op reference', () => {
		const opened = osReducer(initialState, { type: 'agent.openWindow' })
		expect(osReducer(opened, { type: 'agent.openWindow' })).toBe(opened)
	})

	test('window.close closes the agent window like any other', () => {
		const state = run([{ type: 'agent.openWindow' }, { type: 'window.close', id: AGENT_WINDOW_ID }])
		expect(state.windows[AGENT_WINDOW_ID]).toBeUndefined()
		expect(state.openOrder).toEqual([])
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
