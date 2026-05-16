import { defineGUI } from '../sdk'

export const gui = defineGUI<{ count: number }>({
	mount(el, state, ctx) {
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
