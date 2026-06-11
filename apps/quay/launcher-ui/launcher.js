// Phase 1: the launcher list arrives from quayd over the socket. window.quay
// (injected by Launcher.swift) ensures the daemon is running and hands us its
// {port, token}; we open a WebSocket and ask for the catalog. Picking a tile asks
// the native shell to launch that app's .app bundle.

let apps = []
let socket
let retryTimer

const grid = document.getElementById('grid')
const search = document.getElementById('search')
const statusEl = document.getElementById('status')
const messagesEl = document.getElementById('messages')
const ask = document.getElementById('ask')

// The agent chat: a flat transcript the daemon owns. We echo the user turn
// optimistically (+ a pending bubble) and replace it with the authoritative
// transcript the server returns.
let agentMessages = []
let pending = false

function setStatus(text) {
	statusEl.textContent = text
	statusEl.style.display = text ? 'block' : 'none'
}

function launch(id) {
	if (window.quay) window.quay.open(id)
	else console.log('launch', id)
}

function render(filter = '') {
	const q = filter.trim().toLowerCase()
	const items = apps.filter((a) => a.name.toLowerCase().includes(q))
	grid.replaceChildren(
		...items.map((a) => {
			const li = document.createElement('li')
			li.className = 'tile'
			li.tabIndex = 0
			const glyph = document.createElement('span')
			glyph.className = 'glyph'
			glyph.textContent = a.glyph
			const label = document.createElement('span')
			label.className = 'label'
			label.textContent = a.name
			li.append(glyph, label)
			li.addEventListener('click', () => launch(a.id))
			li.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') launch(a.id)
			})
			return li
		})
	)
}

function renderAgent() {
	const bubbles = agentMessages.map((m) => bubble(m.role, m.content, false))
	if (pending) bubbles.push(bubble('assistant', '…', true))
	messagesEl.replaceChildren(...bubbles)
	messagesEl.scrollTop = messagesEl.scrollHeight
}

function bubble(role, content, isPending) {
	const li = document.createElement('li')
	li.className = `msg ${role}${isPending ? ' pending' : ''}`
	li.textContent = content
	return li
}

function sendPrompt() {
	const text = ask.value.trim()
	if (!text || !socket || socket.readyState !== WebSocket.OPEN) return
	agentMessages = [...agentMessages, { id: 'local', role: 'user', content: text }]
	pending = true
	renderAgent()
	socket.send(JSON.stringify({ type: 'prompt', text }))
	ask.value = ''
}

function retry() {
	setStatus('Connecting…')
	clearTimeout(retryTimer)
	retryTimer = setTimeout(connect, 1000)
}

async function connect() {
	if (!window.quay) return setStatus('Connecting…')
	let rt
	try {
		rt = await window.quay.runtime()
	} catch {
		return retry()
	}
	if (!rt) return retry()
	socket = new WebSocket(`ws://127.0.0.1:${rt.port}/?token=${encodeURIComponent(rt.token)}`)
	socket.onopen = () => {
		socket.send(JSON.stringify({ type: 'list' }))
		socket.send(JSON.stringify({ type: 'agent.history' }))
	}
	socket.onmessage = (e) => {
		const msg = JSON.parse(e.data)
		if (msg.type === 'catalog') {
			apps = msg.apps
			setStatus('')
			render(search.value)
		} else if (msg.type === 'agent') {
			agentMessages = msg.messages
			pending = false
			renderAgent()
		}
	}
	socket.onerror = () => socket.close()
	socket.onclose = retry
}

// The native shell calls this when the panel is shown: an offscreen launcher has
// its WebKit timers suspended, so we reconnect the moment it appears (e.g. after
// quayd was killed while the panel was hidden).
window.quayConnect = () => {
	if (!socket || socket.readyState > WebSocket.OPEN) connect()
}

search.addEventListener('input', () => render(search.value))
search.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && window.quay) window.quay.hide()
	if (e.key === 'Enter') {
		const first = grid.querySelector('.tile')
		if (first) first.click()
	}
})

ask.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') {
		e.preventDefault()
		sendPrompt()
	}
	if (e.key === 'Escape' && window.quay) window.quay.hide()
})

connect()
search.focus()
