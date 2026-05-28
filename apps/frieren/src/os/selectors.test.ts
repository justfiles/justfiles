import { describe, expect, test } from 'vitest'
import { osReducer } from './reducer'
import {
	selectChatOpen,
	selectFocusedWindowId,
	selectOpenWindows,
	selectVisibleFullscreenId,
	selectWindowZIndex
} from './selectors'
import { initialState, type OsAction, type OsState } from './state'

function run(actions: OsAction[], from: OsState = initialState): OsState {
	return actions.reduce(osReducer, from)
}

describe('selectors', () => {
	test('selectOpenWindows follows openOrder, not focus', () => {
		const state = run([
			{ type: 'app.open', appId: 'a' },
			{ type: 'app.open', appId: 'b' },
			{ type: 'window.focus', id: 'a' }
		])
		expect(selectOpenWindows(state).map((w) => w.id)).toEqual(['a', 'b'])
	})

	test('selectFocusedWindowId is the top of the focus stack', () => {
		expect(selectFocusedWindowId(initialState)).toBeNull()
		const state = run([
			{ type: 'app.open', appId: 'a' },
			{ type: 'app.open', appId: 'b' }
		])
		expect(selectFocusedWindowId(state)).toBe('b')
	})

	test('selectWindowZIndex ranks by focus stack, 0 when absent', () => {
		const state = run([
			{ type: 'app.open', appId: 'a' },
			{ type: 'app.open', appId: 'b' }
		])
		expect(selectWindowZIndex(state, 'a')).toBe(1)
		expect(selectWindowZIndex(state, 'b')).toBe(2)
		expect(selectWindowZIndex(state, 'missing')).toBe(0)
	})

	test('selectChatOpen reflects the flag', () => {
		expect(selectChatOpen(initialState)).toBe(false)
		expect(selectChatOpen(run([{ type: 'chat.setOpen', open: true }]))).toBe(true)
	})

	test('selectVisibleFullscreenId returns the top fullscreen window, else null', () => {
		const none = run([
			{ type: 'app.open', appId: 'a' },
			{ type: 'app.open', appId: 'b' }
		])
		expect(selectVisibleFullscreenId(none)).toBeNull()

		const one = osReducer(none, { type: 'window.setMode', id: 'a', mode: 'fullscreen' })
		expect(selectVisibleFullscreenId(one)).toBe('a')
	})

	test('with two fullscreen windows, the focused one wins', () => {
		const state = run([
			{ type: 'app.open', appId: 'a' },
			{ type: 'window.setMode', id: 'a', mode: 'fullscreen' },
			{ type: 'app.open', appId: 'b' },
			{ type: 'window.setMode', id: 'b', mode: 'fullscreen' }
		])
		// focusStack is [a, b]; b is on top.
		expect(selectVisibleFullscreenId(state)).toBe('b')
	})

	test('closing the visible fullscreen reveals the next fullscreen down the stack', () => {
		const state = run([
			{ type: 'app.open', appId: 'a' },
			{ type: 'window.setMode', id: 'a', mode: 'fullscreen' },
			{ type: 'app.open', appId: 'b' },
			{ type: 'window.setMode', id: 'b', mode: 'fullscreen' }
		])
		const afterClose = osReducer(state, { type: 'window.close', id: 'b' })
		expect(selectFocusedWindowId(afterClose)).toBe('a')
		expect(selectVisibleFullscreenId(afterClose)).toBe('a')
	})

	test('closing the only fullscreen onto a floating top yields null', () => {
		const state = run([
			{ type: 'app.open', appId: 'a' },
			{ type: 'app.open', appId: 'b' },
			{ type: 'window.setMode', id: 'b', mode: 'fullscreen' }
		])
		// focusStack [a, b]; b fullscreen and visible.
		expect(selectVisibleFullscreenId(state)).toBe('b')
		const afterClose = osReducer(state, { type: 'window.close', id: 'b' })
		expect(selectFocusedWindowId(afterClose)).toBe('a')
		expect(selectVisibleFullscreenId(afterClose)).toBeNull()
	})
})
