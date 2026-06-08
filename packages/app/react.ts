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

export type GUI<A> = (props: GUIProps<A>) => ReactNode
export type GUIMenu<A> = (state: GUIState<A>, actions: Client<A>) => Menu

export interface GUIOptions<A> {
	initial?: GUIState<A>
	menu?: GUIMenu<A>
}

export function defineReactGUI<A>(Component: GUI<A>, options: GUIOptions<A> = {}) {
	const menu = options.menu
	const stateOf = (state: GUIState<A> | null): GUIState<A> =>
		(state ?? options.initial) as GUIState<A>
	return defineGUI<A>({
		menu: menu ? (state, client) => menu(stateOf(state), client) : undefined,
		mount(el, state, ctx) {
			const root = createRoot(el)
			const render = (next: GUIState<A> | null) => {
				root.render(createElement(Component, { state: stateOf(next), actions: ctx.client }))
			}
			render(state)
			return { update: render, unmount: () => root.unmount() }
		}
	})
}
