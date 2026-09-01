import { createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { App } from './app.ts'
import { defineGUI, type GUIContext } from './browser.ts'

type GUIState<A> = A extends App<infer State, infer _C, infer _P, infer _E> ? State : never

export interface GUIProps<A> extends GUIContext<A> {
	readonly state: GUIState<A> | null
}

export function defineReactGUI<A>(Component: (props: GUIProps<A>) => ReactNode) {
	return defineGUI<A>({
		mount(element, state, { client, dialog }) {
			const root = createRoot(element)
			const render = (next: GUIState<A> | null) =>
				root.render(createElement(Component, { state: next, client, dialog }))
			render(state)
			return { update: render, unmount: () => root.unmount() }
		}
	})
}
