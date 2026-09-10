import { defineGUI } from '@justfiles/app/browser'
import type { CounterApp } from './app.ts'

export const gui = defineGUI<CounterApp>({
	mount(root, state, { client }) {
		// Keep DOM nodes across state pushes to preserve focus and selection.
		const button = document.createElement('button')
		button.type = 'button'
		button.onclick = () => void client.increment({ amount: 1 })
		root.append(button)

		const render = (next: { count: number } | null) => {
			button.textContent = `count: ${next?.count ?? 0}`
		}

		render(state)
		return { update: render, unmount: () => button.remove() }
	}
})
