import { createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { App } from './app.ts'
import { defineGUI } from './browser.ts'
import type { Client } from './sdk.ts'

type GUIState<A> = A extends App<infer State, infer _C, infer _P, infer _E> ? State : never

export interface GUIProps<A> {
	state: GUIState<A>
	actions: Client<A>
}

export type GUIComponent<A> = (props: GUIProps<A>) => ReactNode

interface GUIModule<A> {
	gui?: ReturnType<typeof defineGUI<A>>
	default?: GUIComponent<A>
}

// Resolve the `gui` the host expects from a React GUI module's exports (see the
// shim in react-entry.ts). An imperative module exports `gui` directly (a
// `defineGUI` result) and is forwarded as-is; a component module default-exports
// its component, which we wrap. Taking the namespace as a runtime value keeps
// `default` out of the shim's static import graph, so an escape-hatch module
// (no default export) draws no bundler warning.
//
// `state` is non-null to the component: the host resolves the app's
// `initialState` (the reducer's `init`) before mount and only ever pushes
// committed state after, so the nullable `defineGUI` seam is never null here.
// The casts bridge that wider seam to the narrower React contract.
export function reactGui<A>(mod: GUIModule<A>) {
	if (mod.gui) return mod.gui
	const Component = mod.default as GUIComponent<A>
	return defineGUI<A>({
		mount(el, state, ctx) {
			const root = createRoot(el)
			const render = (next: GUIState<A> | null) =>
				root.render(createElement(Component, { state: next as GUIState<A>, actions: ctx.client }))
			render(state)
			return { update: render, unmount: () => root.unmount() }
		}
	})
}
