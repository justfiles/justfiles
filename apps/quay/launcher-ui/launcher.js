// The launcher list arrives from quayd over the socket. window.quay (injected by
// Launcher.swift) ensures the daemon is running and hands us its {port, token};
// we open a WebSocket and ask for the catalog. Picking a row asks the native
// shell to launch that app's .app bundle.

let apps = []
let socket
let retryTimer
let catalogReady = false
let mode = 'launcher'
let selectedIndex = 0
let queuedPrompt = ''

const appEl = document.getElementById('app')
const results = document.getElementById('results')
const search = document.getElementById('search')
const statusEl = document.getElementById('status')
const chat = document.getElementById('chat')
const messagesEl = document.getElementById('messages')
const ask = document.getElementById('ask')

const BAR_HEIGHT = 72
const CHAT_HEIGHT = 520
const MAX_VISIBLE_RESULTS = 7
const ROW_HEIGHT = 46
const ROW_GAP = 4
const RESULTS_GAP = 8
const STATUS_HEIGHT = 26

// The agent chat: a flat transcript the daemon owns. We echo the user turn
// optimistically (+ a pending bubble) and replace it with the authoritative
// transcript the server returns.
let agentMessages = []
let pending = false

function setStatus(text) {
	statusEl.textContent = text
	statusEl.hidden = !text
	resizePanel()
}

function resizePanel() {
	const rows = visibleResultRows()
	const height =
		mode === 'chat'
			? CHAT_HEIGHT
			: BAR_HEIGHT +
				(rows ? RESULTS_GAP + rows * ROW_HEIGHT + (rows - 1) * ROW_GAP : 0) +
				(statusEl.hidden ? 0 : STATUS_HEIGHT)
	window.quay?.resize?.(height)
}

function visibleResultRows() {
	if (mode !== 'launcher' || !search.value.trim()) return 0
	const count = filteredApps().length
	if (!count && !catalogReady) return 0
	return Math.max(1, Math.min(count, MAX_VISIBLE_RESULTS))
}

function filteredApps() {
	const q = search.value.trim().toLowerCase()
	if (!q) return []
	return apps.filter((a) => a.name.toLowerCase().includes(q))
}

function launch(id) {
	if (window.quay) window.quay.open(id)
	else console.log('launch', id)
}

function showLauncher(reset = false) {
	mode = 'launcher'
	appEl.className = ''
	search.hidden = false
	chat.hidden = true
	if (reset) {
		search.value = ''
		selectedIndex = 0
	}
	renderLauncher()
	search.focus()
}

function showChat() {
	mode = 'chat'
	appEl.className = 'chat'
	search.hidden = true
	results.hidden = true
	chat.hidden = false
	renderAgent()
	resizePanel()
	ask.focus()
}

function renderLauncher() {
	if (mode !== 'launcher') return
	const q = search.value.trim()
	const items = filteredApps()

	if (!q || (!items.length && !catalogReady)) {
		results.hidden = true
		results.replaceChildren()
		resizePanel()
		return
	}

	selectedIndex = Math.min(selectedIndex, Math.max(0, items.length - 1))
	results.hidden = false
	results.replaceChildren(...(items.length ? items.map(resultRow) : [askAgentRow(q)]))
	results.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
	resizePanel()
}

function resultRow(app, index) {
	const li = document.createElement('li')
	li.className = `result${index === selectedIndex ? ' selected' : ''}`
	li.addEventListener('mousedown', (e) => e.preventDefault())
	li.addEventListener('mouseenter', () => {
		if (selectedIndex === index) return
		selectedIndex = index
		renderLauncher()
	})
	li.addEventListener('click', () => launch(app.id))

	const glyph = document.createElement('span')
	glyph.className = 'glyph'
	glyph.textContent = app.glyph
	const label = document.createElement('span')
	label.className = 'label'
	label.textContent = app.name
	li.append(glyph, label)
	return li
}

function askAgentRow(text) {
	const li = document.createElement('li')
	li.className = 'result ask-agent selected'
	li.addEventListener('mousedown', (e) => e.preventDefault())
	li.addEventListener('click', () => submitPrompt(text))

	const glyph = document.createElement('span')
	glyph.className = 'glyph'
	glyph.textContent = '↵'
	const label = document.createElement('span')
	label.className = 'label'
	label.textContent = `Ask agent: ${text}`
	li.append(glyph, label)
	return li
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

function submitPrompt(text) {
	const trimmed = text.trim()
	if (!trimmed) return
	showChat()
	agentMessages = [...agentMessages, { id: 'local', role: 'user', content: trimmed }]
	pending = true
	renderAgent()
	if (socket?.readyState === WebSocket.OPEN)
		socket.send(JSON.stringify({ type: 'prompt', text: trimmed }))
	else {
		queuedPrompt = trimmed
		if (!socket || socket.readyState > WebSocket.OPEN) connect()
	}
}

function flushQueuedPrompt() {
	if (!queuedPrompt || socket?.readyState !== WebSocket.OPEN) return
	const text = queuedPrompt
	queuedPrompt = ''
	socket.send(JSON.stringify({ type: 'prompt', text }))
}

function retry() {
	setStatus('Connecting…')
	clearTimeout(retryTimer)
	retryTimer = setTimeout(connect, 1000)
}

async function connect() {
	if (!catalogReady) setStatus('Connecting…')
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
		if (queuedPrompt) flushQueuedPrompt()
		else socket.send(JSON.stringify({ type: 'agent.history' }))
	}
	socket.onmessage = (e) => {
		const msg = JSON.parse(e.data)
		if (msg.type === 'catalog') {
			apps = msg.apps
			catalogReady = true
			setStatus('')
			renderLauncher()
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

window.quayShown = () => {
	showLauncher(true)
	window.quayConnect()
}

search.addEventListener('input', () => {
	selectedIndex = 0
	renderLauncher()
})

search.addEventListener('keydown', (e) => {
	if (e.key === 'Escape') {
		if (window.quay) window.quay.hide()
		return
	}
	if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
		const items = filteredApps()
		if (!items.length) return
		e.preventDefault()
		const delta = e.key === 'ArrowDown' ? 1 : -1
		selectedIndex = Math.max(0, Math.min(items.length - 1, selectedIndex + delta))
		renderLauncher()
		return
	}
	if (e.key === 'Enter') {
		e.preventDefault()
		const text = search.value.trim()
		if (!text) return
		const items = filteredApps()
		if (items.length) launch(items[selectedIndex]?.id ?? items[0].id)
		else if (catalogReady) submitPrompt(text)
	}
})

ask.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') {
		e.preventDefault()
		submitPrompt(ask.value)
		ask.value = ''
	}
	if (e.key === 'Escape' && window.quay) window.quay.hide()
})

showLauncher(true)
connect()
