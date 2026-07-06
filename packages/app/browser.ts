import type { App } from './app.ts'
import { type Client, createClient, type Transport } from './sdk.ts'

type GUIState<A> = A extends App<infer State, infer _C, infer _P, infer _E> ? State : never

const injected = new Set<string>()

// An app's scoped stylesheet, injected once into the document. A built app bundle
// serves only `gui.js`, so an app's layout CSS rides inside it and self-applies on
// import — identically in any host (frieren, quay), with no separate served file
// and no host CSS plumbing. `key` dedups across remounts/HMR (defaults to the CSS
// itself). The platform look (`@justfiles/design/mac`) is the host's job; this is
// for an app's own layout.
export function injectStyle(css: string, key = css): void {
	if (typeof document === 'undefined' || injected.has(key)) return
	injected.add(key)
	const style = document.createElement('style')
	style.textContent = css
	document.head.append(style)
}

interface GUISpec<A> {
	// The app's typed client is injected; the GUI never touches transport.
	// `state` is nullable — the host may mount before the kernel has any
	// persisted state for this app, or before the WS round-trip completes.
	mount: (
		el: HTMLElement,
		state: GUIState<A> | null,
		ctx: { readonly client: Client<A> }
	) => GUIInstance<GUIState<A> | null>
}

interface GUIInstance<State> {
	update: (state: State) => Promise<void> | void
	unmount: () => Promise<void> | void
}

// `defineGUI<typeof app>`. The host injects only the transport; defineGUI
// builds the typed client from it (so the host needs no createClient and
// the GUI needs no transport) and bridges host state pushes into the GUI's
// `update`. The GUI never reads the action return value — state flows in
// one direction, from the host through `subscribe`.
export function defineGUI<A>(spec: GUISpec<A>) {
	return {
		mount(el: HTMLElement, state: GUIState<A> | null, ctx: { transport: Transport }) {
			const client = createClient<A>(ctx.transport)
			const instance = spec.mount(el, state, { client })
			const unsubscribe = ctx.transport.subscribe((next) => {
				instance.update(next as GUIState<A> | null)
			})
			return {
				update: instance.update,
				async unmount() {
					unsubscribe()
					await instance.unmount()
				}
			}
		}
	}
}
