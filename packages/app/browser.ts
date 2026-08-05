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

/**
 * Reconcile a pushed state against the one the GUI is already showing, reusing
 * the PREVIOUS reference for every branch that is deep-equal.
 *
 * State reaches a GUI across a structured-clone boundary (the host posts it
 * through a MessagePort), so every object in it arrives with a fresh identity —
 * even when nothing about it changed. Rendering straight off that push makes a
 * push that decided nothing indistinguishable from one that did: the whole tree
 * re-renders, and every `useMemo`/`useEffect` keyed on a slice of state re-runs.
 * That is what turns an ambient wake — a sync cycle re-applying bytes a file
 * already held, a host re-reading state it did not author — into a visible flash.
 *
 * Sharing gives two properties at once, for every app, with nothing to remember
 * at a call site:
 *   - a state equal to the current one reconciles to that very object, so the
 *     push can be dropped and NO render happens;
 *   - a real change renders with only the touched branches new, so React bails
 *     out of the rest and deps on untouched slices stay stable.
 *
 * The domain is JSON: the kernel serializes state to `/state/<id>.json`, so
 * plain objects, arrays and primitives are all there is (no cycles, no classes).
 */
type Branch = Record<string, unknown>

function share(prev: unknown, next: unknown): unknown {
	if (prev === next) return prev
	if (!isBranch(prev) || !isBranch(next) || Array.isArray(prev) !== Array.isArray(next)) return next
	const keys = Object.keys(next)
	// A key set of the same size whose every value shared back to `prev`'s IS
	// `prev` — a differing key can't hide in it, because its value would have had
	// to share against a `prev` that has nothing there.
	let unchanged = keys.length === Object.keys(prev).length
	const merged: Branch = Array.isArray(next) ? ([] as unknown as Branch) : {}
	for (const key of keys) {
		const value = share(prev[key], next[key])
		if (value !== prev[key]) unchanged = false
		merged[key] = value
	}
	return unchanged ? prev : merged
}

function isBranch(value: unknown): value is Branch {
	return typeof value === 'object' && value !== null
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
			// What the GUI is currently showing. Pushes are reconciled against it (see
			// `share`), so an app renders on CHANGE rather than on arrival.
			let shown: unknown = state
			const unsubscribe = ctx.transport.subscribe((next) => {
				const merged = share(shown, next)
				if (merged === shown) return
				shown = merged
				instance.update(merged as GUIState<A> | null)
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
