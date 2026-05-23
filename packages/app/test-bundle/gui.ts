import { defineGUI } from '../sdk'
import type { app } from './app.ts'

export const gui = defineGUI<typeof app>({
	mount(el, state, _ctx) {
		el.textContent = `count: ${state.count}`
		document.body.appendChild(el)

		return {
			update(state) {
				el.textContent = `count: ${state.count}`
				return
			},
			unmount() {
				document.body.removeChild(el)
			}
		}
	}
})
