// A framework-free GUI: plain DOM through `defineGUI`. Packages are bundled into
// gui.js by default; kernelHost can map browser packages to pinned esm.sh URLs.
//
// Build the chrome ONCE in `mount` and mutate it on each state push. Rebuilding
// the subtree instead would drop focus, caret, and selection; that persistence is
// what a reconciler would otherwise be buying you.
import { defineGUI } from '@justfiles/app/browser'
import type { CounterApp } from './app.ts'

export const gui = defineGUI<CounterApp>({
	mount(root, state, { client }) {
		// A bare `<button>`: the host injects the platform stylesheet, so it is
		// already styled and already follows the OS light/dark theme. Your own
		// layout CSS goes through `injectStyle` from the same module.
		const button = document.createElement('button')
		button.type = 'button'
		button.onclick = () => void client.increment({ amount: 1 })
		root.append(button)

		// Null until the kernel has state for this app — mount on the app's init.
		const render = (next: { count: number } | null) => {
			button.textContent = `count: ${next?.count ?? 0}`
		}

		render(state)
		return { update: render, unmount: () => button.remove() }
	}
})
