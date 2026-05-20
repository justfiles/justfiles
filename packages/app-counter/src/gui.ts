import { defineGUI } from '@justfiles/app/kernel/sdk'
import type { HelloApp } from './app'

export const gui = defineGUI<HelloApp>({
	mount(el, state, ctx) {
		console.log('mount')
		const out = document.createElement('output')
		const dec = document.createElement('button')
		const inc = document.createElement('button')
		dec.textContent = '-'
		inc.textContent = '+'

		// `state` is null before the first dispatch — the host has no
		// committed state to push. GUI authors own the bootstrap default.
		const render = (s: { count: number } | null) => {
			out.textContent = `count: ${s?.count ?? 0}`
		}
		render(state)

		// Fire the action; the host validates, commits, and pushes the
		// new state back through `update`. The return value is ignored.
		dec.onclick = () => void ctx.client.decrement({ amount: 1 })
		inc.onclick = () => void ctx.client.increment({ amount: 1 })
		el.append(dec, out, inc)

		return {
			update(next) {
				console.log('rendering', { next })
				render(next)
			},
			unmount() {
				el.replaceChildren()
			}
		}
	}
})
