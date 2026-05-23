import type { App } from './app.ts'
import { type Client, createClient, type Transport } from './sdk.ts'

type GUIState<A> = A extends App<infer State, infer _Schemas, infer _Caps> ? State : never

interface GUISpec<A> {
	// The app's typed client is injected; the GUI never touches transport.
	mount: (
		el: HTMLElement,
		state: GUIState<A>,
		ctx: { readonly client: Client<A> }
	) => GUIInstance<GUIState<A>>
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
		mount(el: HTMLElement, state: GUIState<A>, ctx: { transport: Transport }) {
			const instance = spec.mount(el, state, { client: createClient<A>(ctx.transport) })
			const unsubscribe = ctx.transport.subscribe((next) => instance.update(next as GUIState<A>))
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
