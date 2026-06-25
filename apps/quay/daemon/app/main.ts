import { newWebSocketRpcSession } from 'capnweb'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')

const appId = decodeURIComponent(location.pathname.split('/').at(-1) ?? '')

const berth = newWebSocketRpcSession(`ws://${location.host}/app/${appId}/connect`)

const app = await import(`/app/${appId}/gui.js`)

const state = await berth.state()

app.gui.mount(root, state, {
	transport: {
		invoke: (message) => berth.dispatch(message),
		subscribe: (onState) => {
			berth.subscribe(onState)
		}
	}
})
