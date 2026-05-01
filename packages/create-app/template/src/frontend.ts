import '@justfiles/app/client'
import './index.css'

type Snapshot = {
	state: string
	context: {
		count?: number
	}
}

const root = document.querySelector<HTMLDivElement>('#root')

function render(value: unknown) {
	const snapshot = value as Snapshot | undefined
	const count = snapshot?.context.count ?? 0

	if (!root) return
	root.replaceChildren(
		button('-', 'decrement'),
		Object.assign(document.createElement('span'), { textContent: String(count) }),
		button('+', 'increment')
	)
}

window.app.subscribe(render)
render(window.app.state)

function button(label: string, type: string) {
	const el = document.createElement('button')
	el.textContent = label
	el.addEventListener('click', () => window.app.dispatch({ type, payload: {} }))
	return el
}
