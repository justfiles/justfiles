/// <reference types="vite/client" />
import { mountDialogHost } from './dialog-host.ts'
import { mountAppFrame } from './iframe.ts'

const root = document.getElementById('app')!
const error = document.createElement('pre')
error.id = 'build-error'
error.hidden = true
error.setAttribute('role', 'alert')
document.body.append(error)
const showError = (message = '') => {
	error.textContent = message
	error.hidden = !message
}
let frame: ReturnType<typeof mountAppFrame> | undefined
let dialog: ReturnType<typeof mountDialogHost> | undefined
let version = -1
let latest: { version: number; code?: string; error?: string } | undefined
let ready = false
let state: unknown
const receive = (bundle: NonNullable<typeof latest>) => {
	if (bundle.version <= version) return
	latest = bundle
	if (!ready) return
	version = bundle.version
	showError(bundle.error)
	if (bundle.error && frame) return
	if (!bundle.code) return
	frame?.dispose()
	dialog?.unmount()
	dialog = mountDialogHost(document.body, { source: document.title })
	frame = mountAppFrame(root, bundle.code, state, {
		invoke: async (action) => {
			const response = await fetch('/_dispatch', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(action)
			})
			if (!response.ok) throw new Error(await response.text())
			return response.json()
		},
		dialog: dialog.request,
		onError: showError,
		onMessage: (message) => {
			if (
				message.type === 'title' &&
				typeof message.title === 'string' &&
				message.title.length <= 200 &&
				message.title
			)
				document.title = message.title
		}
	})
}
const hot = import.meta.hot
hot?.on('kernel-host:gui', receive)
state = await fetch('/_state').then((response) => response.json())
ready = true
if (latest) receive(latest)
receive(await fetch('/_kernel-host/gui').then((response) => response.json()))
const events = new EventSource('/_subscribe')
events.onmessage = (event) => {
	state = JSON.parse(event.data)
	frame?.update(state)
}
hot?.dispose(() => {
	hot.off('kernel-host:gui', receive)
	events.close()
	frame?.dispose()
	dialog?.unmount()
})
