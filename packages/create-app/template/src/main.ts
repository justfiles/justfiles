import './style.css'
import './app-sdk'

const root = document.querySelector<HTMLElement>('#app')
if (!root) throw new Error('missing #app')

let count = 0

root.innerHTML = `
	<h1>Hello</h1>
	<p>Count: <strong id="count">0</strong></p>
	<button id="inc" type="button">+</button>
	<button id="dec" type="button">-</button>
`

const setCount = (next: number) => {
	count = next
	const el = document.getElementById('count')
	if (el) el.textContent = String(count)
}

document.getElementById('inc')?.addEventListener('click', () => setCount(count + 1))
document.getElementById('dec')?.addEventListener('click', () => setCount(count - 1))

window.app?.lifecycle.onStart(() => {
	void window.app?.volume
		.readText('count.txt')
		.then((text) => setCount(Number.parseInt(text, 10) || 0))
		.catch(() => setCount(0))
})
