import { defineGUI } from '@justfiles/app/browser'
import type { app } from './app.ts'
import './style.css'
import icon from './mark.svg'

const materialCode = `
let count = 0
const button = document.querySelector('button')
button.onclick = () => { button.textContent = 'Material count: ' + ++count }
document.addEventListener('selectionchange', () => {
	parent.postMessage({ type: 'selection', text: String(getSelection()).slice(0, 200) }, '*')
})
let isolated = false
try { parent.document.body } catch { isolated = true }
document.querySelector('output').textContent = 'Isolated: ' + isolated
parent.postMessage({ type: 'material-ready', isolated, client: typeof client }, '*')
`

export const gui = defineGUI<typeof app>({
	mount(root, state, { client, dialog }) {
		root.innerHTML = `<h1>GUI parity fixture</h1><img width="20" alt="Bundled asset" src="${icon}">
<button id="increment">Host count: ${state?.count ?? 0}</button>
<button id="dialog">Confirm</button><output id="dialog-result"></output>
<button id="download">Download</button>
<label>Window title <input id="title" value="GUI parity fixture"></label>
<output id="isolation"></output><output id="selection"></output>`
		const increment = root.querySelector<HTMLButtonElement>('#increment')!
		increment.onclick = () => void client.increment({})
		root.querySelector<HTMLButtonElement>('#dialog')!.onclick = async () => {
			root.querySelector('#dialog-result')!.textContent = String(
				await dialog.confirm({
					title: 'Fixture dialog',
					confirmLabel: 'Continue'
				})
			)
		}
		root.querySelector<HTMLButtonElement>('#download')!.onclick = () => {
			const url = URL.createObjectURL(new Blob(['GUI parity download'], { type: 'text/plain' }))
			const link = document.createElement('a')
			link.href = url
			link.download = 'gui-parity.txt'
			link.click()
			setTimeout(() => URL.revokeObjectURL(url), 10_000)
		}
		document.title = 'GUI parity fixture'
		root.querySelector<HTMLInputElement>('#title')!.oninput = (event) => {
			document.title = (event.target as HTMLInputElement).value
		}
		let isolated = false
		try {
			void parent.document.body
		} catch {
			isolated = true
		}
		root.querySelector('#isolation')!.textContent = `GUI isolated: ${isolated}`
		const material = document.createElement('iframe')
		material.title = 'Material'
		material.setAttribute('sandbox', 'allow-scripts')
		material.srcdoc = `<button>Material count: 0</button><p>Select this material text</p><output></output>
<script type="module">
const url = URL.createObjectURL(new Blob([${JSON.stringify(materialCode)}], { type: 'text/javascript' }))
try { await import(url) } finally { URL.revokeObjectURL(url) }
</script>`
		const receive = (event: MessageEvent) => {
			if (event.source !== material.contentWindow) return
			if (event.data?.type === 'selection' && typeof event.data.text === 'string')
				root.querySelector('#selection')!.textContent = event.data.text.slice(0, 200)
			if (event.data?.type === 'material-ready') root.dataset.material = JSON.stringify(event.data)
		}
		window.addEventListener('message', receive)
		root.append(material)
		return {
			update(state) {
				increment.textContent = `Host count: ${state?.count ?? 0}`
			},
			unmount() {
				window.removeEventListener('message', receive)
				root.replaceChildren()
			}
		}
	}
})
