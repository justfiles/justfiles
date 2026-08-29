import { createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { App } from './app.ts'
import { defineGUI } from './browser.ts'
import type { Client } from './sdk.ts'

type GUIState<A> = A extends App<infer State, infer _C, infer _P, infer _E> ? State : never

export interface GUIProps<A> {
	readonly state: GUIState<A> | null
	readonly client: Client<A>
}

export function defineReactGUI<A>(Component: (props: GUIProps<A>) => ReactNode) {
	return defineGUI<A>({
		mount(element, state, { client }) {
			const root = createRoot(element)
			const render = (next: GUIState<A> | null) =>
				root.render(createElement(Component, { state: next, client }))
			render(state)
			return { update: render, unmount: () => root.unmount() }
		}
	})
}
