import '@justfiles/design/design.css'
import '@justfiles/design/mac.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')

const appId = decodeURIComponent(location.pathname.split('/').at(-1) ?? '')

// A minimal request/response + state-push channel over one WebSocket. The GUI's
// generated client only ever does flat `invoke({type,params})` and `subscribe`,
// so there's no RPC framework here: calls are correlated by `id`, and the server
// pushes authoritative state frames (the initial snapshot on connect, then every
// update via Bun pub/sub) which we hand to the subscriber.
type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void }

function connect(appId: string) {
	const ws = new WebSocket(`ws://${location.host}/app/${appId}/connect`)
	const pending = new Map<number, Pending>()
	let seq = 0
	let onState: ((state: unknown) => void) | undefined
	let last: unknown
	let got = false
	let resolveFirst!: (state: unknown) => void
	const first = new Promise<unknown>((r) => (resolveFirst = r))
	const opened = new Promise<void>((r) => (ws.onopen = () => r()))

	ws.onmessage = (e) => {
		const msg = JSON.parse(e.data)
		if (msg.reload === true) {
			location.reload()
			return
		}
		if ('id' in msg) {
			const p = pending.get(msg.id)
			if (!p) return
			pending.delete(msg.id)
			if (msg.ok) p.resolve(msg.value)
			else p.reject(new Error(msg.error))
			return
		}
		last = msg.state
		if (!got) {
			got = true
			resolveFirst(msg.state)
		}
		onState?.(msg.state)
	}

	const transport = {
		async invoke(message: { type: string; params: unknown }) {
			await opened
			const id = ++seq
			return new Promise<unknown>((resolve, reject) => {
				pending.set(id, { resolve, reject })
				ws.send(JSON.stringify({ id, ...message }))
			})
		},
		subscribe(cb: (state: unknown) => void) {
			onState = cb
			if (got) cb(last) // flush the snapshot received before mount
			return () => {
				if (onState === cb) onState = undefined
			}
		}
	}

	return { transport, first }
}

const { transport, first } = connect(appId)
// The gui.js is served by the daemon at this absolute URL at runtime; @vite-ignore stops
// Vite from trying to statically analyze (and warn about) the dynamic specifier.
const [app, state] = await Promise.all([import(/* @vite-ignore */ `/app/${appId}/gui.js`), first])
app.gui.mount(root, state, { transport })
