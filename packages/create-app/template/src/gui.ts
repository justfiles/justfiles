import { defineGUI } from '@justfiles/app'
import type { ExampleApp } from './app'

export const gui = defineGUI<ExampleApp>({
	mount(el, state, ctx) {
		const button = document.createElement('button')
		button.textContent = label(state)
		button.onclick = () => void ctx.client.increment({ amount: 1 })
		el.append(button)
		return {
			update(next) {
				button.textContent = label(next)
			},
			unmount() {
				el.replaceChildren()
			}
		}
	}
})

function label(state: { count?: number } | null) {
	return `count: ${state?.count ?? 0}`
}
