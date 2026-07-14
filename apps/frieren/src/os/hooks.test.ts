import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { useOsClient, useOsDispatch, useOsStore } from './hooks'
import { OSProvider } from './Provider'

vi.mock('@clerk/clerk-react', () => ({
	useAuth: () => ({ getToken: async () => null, userId: 'user-1' }),
	useUser: () => ({ user: null })
}))

vi.mock('../fs', () => ({
	activeProfileHasRemoteUser: () => false,
	openProfile: async () => ({
		exists: async () => false,
		readFile: async () => new Uint8Array(),
		mkdir: async () => {},
		writeFile: async () => {},
		status: () => 'local-only'
	})
}))

vi.mock('../apps/host', () => ({
	open: () => {},
	close: () => {}
}))

function render(element: ReactElement): string {
	return renderToString(element)
}

describe('OS hooks', () => {
	test('throw a clear error outside provider', () => {
		function Consumer() {
			useOsDispatch()
			return null
		}

		expect(() => render(createElement(Consumer))).toThrow(
			'OS hooks must be used inside <OSProvider>'
		)
	})

	test('useOsStore reads through context without prop-drilling the store', () => {
		function Consumer() {
			const booted = useOsStore((state) => state.booted)
			const dispatch = useOsDispatch()
			const client = useOsClient()
			return createElement('span', null, `${booted}:${typeof dispatch}:${typeof client.send}`)
		}

		expect(render(createElement(OSProvider, null, createElement(Consumer)))).toContain(
			'false:function:function'
		)
	})
})
