// quay launcher — a single bottom-anchored surface, spotlight-first. The composer
// is pinned at the bottom; above it we show matching apps as you type. It stays a
// launcher by default: the agent transcript is not the resting state. When you're
// not in a conversation the bar surfaces at most one default-action row — "ask the
// agent this text", or "resume" the last conversation — so chat is one Enter away
// but never takes over. The full transcript appears only once you're `chatting`
// (you sent a message, hit ⌘K, or resumed); sending just appends to it.
//
// window.quay (injected by Launcher.swift) ensures quayd is running and hands us
// {port, token}; we open a WebSocket for the catalog and the agent transcript.
// Picking an app asks the native shell to launch that app's .app bundle.

let apps = []
let socket
let retryTimer
let catalogReady = false
let selectedIndex = 0
let queuedPrompt = ''

// Sticky chat intent: once you send (or hit ⌘K) typing composes a message and no
// longer filters apps, so a follow-up like "could…" can't yank the transcript out
// to the Code/Counter apps. ⌘K — or summoning the panel afresh — returns to apps.
let chatting = false

// The agent transcript: a flat list the daemon owns. We echo the user turn
// optimistically (+ a pending bubble) and replace it with the authoritative
// transcript the server returns.
let agentMessages = []
let pending = false

// The last height we asked the native shell for. Most keystrokes (filtering within
// the same row count) don't change it, so we skip the resize — a native setFrame on
// every keystroke recomposites the whole panel and flickers.
let lastSentHeight = 0

const contentEl = document.getElementById('content')
const statusEl = document.getElementById('status')
const composer = document.getElementById('composer')

const PAD = 12 // #app padding (top + bottom = 24)
const GAP = 8 // gap between #app's stacked rows
const STATUS_H = 18
const ROW_HEIGHT = 46
const ROW_GAP = 4
const MAX_VISIBLE_RESULTS = 7
const APPS_CAP = MAX_VISIBLE_RESULTS * ROW_HEIGHT + (MAX_VISIBLE_RESULTS - 1) * ROW_GAP
const CHAT_CAP = 460

function filteredApps(q) {
	const needle = q.toLowerCase()
	return apps.filter((a) => a.name.toLowerCase().includes(needle))
}

// We're waiting on the agent if we just sent (pending) or the transcript still
// ends on a user turn the daemon hasn't answered yet.
function awaitingReply() {
	return pending || agentMessages.at(-1)?.role === 'user'
}

// The single render: decides what sits above the composer and resizes the panel.
// While chatting, the transcript. Otherwise we're a launcher: app matches if the
// query hits the catalog, else a single default-action row (ask / resume).
function render() {
	if (chatting) return renderTranscript()
	const q = composer.value.trim()
	const matches = q ? filteredApps(q) : []
	if (matches.length) renderApps(matches)
	else renderHint(q)
}

function renderApps(matches) {
	contentEl.classList.add('apps')
	contentEl.hidden = false
	selectedIndex = Math.max(0, Math.min(selectedIndex, matches.length - 1))
	contentEl.replaceChildren(...matches.map(resultRow))
	sizePanel()
	contentEl.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
}

function renderTranscript() {
	contentEl.classList.remove('apps')
	const bubbles = agentMessages.map((m) => bubble(m.role, m.content, false))
	if (awaitingReply()) bubbles.push(bubble('assistant', '…', true))
	contentEl.hidden = bubbles.length === 0
	contentEl.replaceChildren(...bubbles)
	sizePanel()
	contentEl.scrollTop = contentEl.scrollHeight // newest sits just above the composer
}

// Launcher resting state: at most one default-action row above the bar. With text
// that matches no app, Enter asks the agent; with an empty bar and a prior
// conversation, Enter resumes it. The full transcript stays out of the way until
// you're actually `chatting`.
function renderHint(q) {
	contentEl.classList.remove('apps')
	let row = null
	if (q) row = hintRow(`Ask agent “${q}”`)
	else if (agentMessages.length) row = hintRow(resumeLabel())
	contentEl.hidden = !row
	contentEl.replaceChildren(...(row ? [row] : []))
	sizePanel()
}

// The resume row doubles as a status peek: if we dismissed mid-reply it says so,
// otherwise it previews the latest answer (CSS truncates it to one line).
function resumeLabel() {
	if (awaitingReply()) return 'Resume — agent is replying…'
	const last = agentMessages.at(-1)?.content?.trim()
	return last ? `Resume — ${last}` : 'Resume conversation'
}

// The intrinsic height of the rows, measured as the span from the first child's
// top to the last child's bottom. We can't use scrollHeight here: #content is a
// flex:1 item stretched to the panel's current height, and scrollHeight never
// reports less than that box — so it'd hold the old (taller) size when the list
// shrinks. The child span ignores the stretched box, so the panel tracks shrink.
function contentHeight() {
	const kids = contentEl.children
	if (!kids.length) return 0
	let top = Infinity
	let bottom = -Infinity
	for (const k of kids) {
		top = Math.min(top, k.offsetTop)
		bottom = Math.max(bottom, k.offsetTop + k.offsetHeight)
	}
	return bottom - top
}

// Grow upward to fit the content (capped, then it scrolls). The native shell keeps
// the composer's bottom edge pinned, so the panel extends up over the desktop.
function sizePanel() {
	const cap = contentEl.classList.contains('apps') ? APPS_CAP : CHAT_CAP
	const contentH = contentEl.hidden ? 0 : Math.min(contentHeight(), cap)
	// The composer auto-grows (field-sizing), so read its live height here — every
	// render runs through sizePanel, so the panel tracks the textarea as it wraps.
	let h = PAD * 2 + composer.offsetHeight
	if (contentH) h += contentH + GAP
	if (!statusEl.hidden) h += STATUS_H + GAP
	if (h === lastSentHeight) return
	lastSentHeight = h
	window.quay?.resize?.(h)
}

function resultRow(app, index) {
	const li = document.createElement('li')
	li.className = `result${index === selectedIndex ? ' selected' : ''}`
	li.addEventListener('mousedown', (e) => e.preventDefault())
	li.addEventListener('mouseenter', () => {
		if (selectedIndex === index) return
		selectedIndex = index
		for (const el of contentEl.children) el.classList.toggle('selected', el === li)
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

function bubble(role, text, isPending) {
	const li = document.createElement('li')
	li.className = `msg ${role}${isPending ? ' pending' : ''}`
	li.textContent = text
	return li
}

// The default-action row (ask / resume). Reuses the app-row look so it reads as the
// selected default; clicking or Enter acts on it. Glyph ✦ marks it as the agent.
function hintRow(text) {
	const li = document.createElement('li')
	li.className = 'result hint selected'
	li.addEventListener('mousedown', (e) => e.preventDefault())
	li.addEventListener('click', () => {
		if (composer.value.trim()) sendMessage(composer.value)
		else resumeChat()
	})
	const glyph = document.createElement('span')
	glyph.className = 'glyph'
	glyph.textContent = '✦'
	const label = document.createElement('span')
	label.className = 'label'
	label.textContent = text
	li.append(glyph, label)
	return li
}

function setStatus(text) {
	statusEl.textContent = text
	statusEl.hidden = !text
	sizePanel()
}

function launch(id) {
	if (window.quay) window.quay.open(id)
	else console.log('launch', id)
}

function sendMessage(text) {
	const trimmed = text.trim()
	if (!trimmed) return
	chatting = true // stick to the transcript for follow-ups
	agentMessages = [...agentMessages, { id: 'local', role: 'user', content: trimmed }]
	pending = true
	composer.value = ''
	selectedIndex = 0
	render()
	if (socket?.readyState === WebSocket.OPEN)
		socket.send(JSON.stringify({ type: 'prompt', text: trimmed }))
	else {
		queuedPrompt = trimmed
		if (!socket || socket.readyState > WebSocket.OPEN) connect()
	}
}

// ⌘K is the explicit switch between app-search and the conversation: leaving chat
// so typing filters apps again, or forcing the transcript up to read/compose.
function toggleChat() {
	chatting = !chatting
	selectedIndex = 0
	render()
	composer.focus()
}

// Step into the existing conversation (the resume default-action). No-op with an
// empty transcript, so Enter on a truly empty bar does nothing.
function resumeChat() {
	if (!agentMessages.length) return
	chatting = true
	selectedIndex = 0
	render()
	composer.focus()
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
			render()
		} else if (msg.type === 'agent') {
			agentMessages = msg.messages
			pending = false
			render()
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

// Summon lands deterministically in app-search with a cleared composer; the last
// conversation is still right there above it to read or continue.
window.quayShown = () => {
	composer.value = ''
	selectedIndex = 0
	chatting = false
	lastSentHeight = 0 // native show() reset the panel to 72px without telling us
	render()
	composer.focus()
	window.quayConnect()
}

document.addEventListener('keydown', (e) => {
	if (e.key === 'k' && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
		e.preventDefault()
		toggleChat()
	}
})

composer.addEventListener('input', () => {
	selectedIndex = 0
	render()
})

composer.addEventListener('keydown', (e) => {
	if (e.key === 'Escape') {
		window.quay?.hide?.()
		return
	}

	const showingApps = !contentEl.hidden && contentEl.classList.contains('apps')

	if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
		e.preventDefault()
		if (showingApps) {
			const matches = filteredApps(composer.value.trim())
			if (!matches.length) return
			// index 0 (best) sits at the bottom (column-reverse), so ↑ walks up the list.
			const delta = e.key === 'ArrowUp' ? 1 : -1
			selectedIndex = Math.max(0, Math.min(matches.length - 1, selectedIndex + delta))
			render()
		} else if (!contentEl.hidden) {
			contentEl.scrollTop += e.key === 'ArrowUp' ? -60 : 60 // scroll the transcript
		}
		return
	}

	// Enter sends; Shift+Enter falls through to the textarea to insert a newline.
	if (e.key === 'Enter' && !e.shiftKey) {
		e.preventDefault()
		const text = composer.value.trim()
		if (chatting) {
			if (text) sendMessage(text)
		} else if (showingApps) {
			const matches = filteredApps(text)
			if (matches.length) launch((matches[selectedIndex] ?? matches[0]).id)
		} else if (text) {
			sendMessage(text) // no app match → ask the agent
		} else {
			resumeChat() // empty bar → step back into the conversation
		}
	}
})

render()
composer.focus()
connect()
