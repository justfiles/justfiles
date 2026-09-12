import { defineGUI } from '@justfiles/app/browser'
import type { app } from './app.ts'

export const gui = defineGUI<typeof app>({
	mount(root, state, { client }) {
		root.innerHTML = `<h1>Dev agent fixture</h1>
<label>Task <textarea id="prompt" rows="5" cols="70">Read https://example.com using the fetch host operation. Write the page's title and source URL into /research.md through the files capability. Return a brief confirmation.</textarea></label>
<p><button id="run">Research</button> <button id="stop">Stop</button> <button id="tick">Tick</button> <button id="read">Read saved file</button></p>
<p id="ticks"></p><pre id="status"></pre><pre id="file"></pre>`
		const get = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!
		let requestId = ''
		get('run').onclick = async () => {
			requestId = crypto.randomUUID()
			get('status').textContent = 'Running'
			try {
				get('status').textContent = JSON.stringify(
					await client.work({ requestId, prompt: get<HTMLTextAreaElement>('prompt').value })
				)
			} catch (error) {
				get('status').textContent = String(error)
			}
		}
		get('stop').onclick = () => void client.stop({ requestId })
		get('tick').onclick = () => void client.tick({})
		get('read').onclick = async () => {
			try {
				get('file').textContent = await client.read({})
			} catch (error) {
				get('file').textContent = String(error)
			}
		}
		const update = (state: { ticks: number } | null) => {
			get('ticks').textContent = `Ticks: ${state?.ticks ?? 0}`
		}
		update(state)
		return {
			update,
			unmount() {
				root.replaceChildren()
			}
		}
	}
})
