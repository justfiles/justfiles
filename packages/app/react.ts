import { createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { App } from './app.ts'
import { defineGUI, type Menu } from './browser.ts'
import type { Client } from './sdk.ts'

type GUIState<A> = A extends App<infer State, infer _C, infer _P, infer _E> ? State : never

export interface GUIProps<A> {
	state: GUIState<A>
	actions: Client<A>
}

export type GUIComponent<A> = (props: GUIProps<A>) => ReactNode
export type GUIMenu<A> = (state: GUIState<A>, actions: Client<A>) => Menu

export interface GUIOptions<A> {
	menu?: GUIMenu<A>
}

// `state` is non-null to the component and menu: the host resolves the app's
// `initialState` (the reducer's `init`) before mount and only ever pushes
// committed state after, so the nullable `defineGUI` seam is never null here.
// The casts bridge that wider seam to the narrower React contract.
export function defineReactGUI<A>(Component: GUIComponent<A>, options: GUIOptions<A> = {}) {
	const menu = options.menu
	return defineGUI<A>({
		menu: menu ? (state, client) => menu(state as GUIState<A>, client) : undefined,
		mount(el, state, ctx) {
			const root = createRoot(el)
			const render = (next: GUIState<A> | null) =>
				root.render(createElement(Component, { state: next as GUIState<A>, actions: ctx.client }))
			render(state)
			return { update: render, unmount: () => root.unmount() }
		}
	})
}
