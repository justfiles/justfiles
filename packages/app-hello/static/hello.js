const el = document.getElementById('time')
const status = document.getElementById('status')
const last = document.getElementById('last')
const tick = () => {
	if (el) el.textContent = new Date().toLocaleTimeString()
}
tick()
setInterval(tick, 1000)

// Internal state the agent should never see (e.g. draft text, unsaved form data).
const _private = { draftNote: 'work in progress — not for agent eyes' }

const highlightTarget = document.getElementById('highlight-target')
const toolNotice = document.getElementById('tool-notice')

// Register a client-side agent tool. The handler runs here in the iframe,
// proving that client code — not the server — executed it by mutating the DOM.
window.app?.agent.tools.register({
	name: 'highlight',
	description:
		'Highlight the demo text in the Hello app with a chosen color. Use this to prove the client-side handler ran.',
	schema: {
		type: 'object',
		properties: {
			color: {
				type: 'string',
				description: 'CSS color value, e.g. "yellow", "#ff0", "rgba(0,255,0,0.3)"'
			}
		},
		required: ['color']
	},
	handler(input) {
		const color = input && typeof input.color === 'string' ? input.color : 'yellow'
		if (highlightTarget) {
			highlightTarget.style.background = color
		}
		if (toolNotice) {
			toolNotice.textContent = `Agent called highlight(${color}) — handler ran in the iframe ✓`
			toolNotice.dataset.state = 'triggered'
		}
		return { highlighted: true, color }
	}
})

// Register a safe projection: exposes only what the agent needs to help the
// user, keeping private/internal state out of the description.
window.app?.agent.describe(() => {
	const appStatus = status?.dataset.started === 'true' ? 'running' : 'waiting'
	const lastVisit = last?.textContent ?? 'unknown'
	const highlight = highlightTarget?.style.background || 'none'
	// _private intentionally omitted
	return `Hello app is ${appStatus}. ${lastVisit}. Current highlight color: ${highlight}.`
})

window.app?.lifecycle.onStart(async () => {
	if (status) {
		status.textContent = `started · app sdk v${window.app.version}`
		status.dataset.started = 'true'
	}

	// Round-trip through the volume bridge: read the value persisted on the
	// previous visit, then overwrite it with this visit's timestamp. Reload
	// the iframe to see the previously saved value.
	try {
		const previous = await window.app.volume.readText('last.txt')
		if (last) {
			last.textContent = `last visit: ${previous}`
			last.dataset.state = 'recalled'
		}
	} catch (err) {
		if (last) {
			last.textContent =
				err?.code === -32001
					? 'last visit: first launch'
					: `last visit: error (${err?.message ?? err})`
			last.dataset.state = err?.code === -32001 ? 'first' : 'error'
		}
	}
	try {
		await window.app.volume.writeText('last.txt', new Date().toISOString())
	} catch (err) {
		console.error('failed to persist last visit:', err)
	}

	const sayHi = document.getElementById('say-hi')
	const agentStatus = document.getElementById('agent-status')
	sayHi?.addEventListener('click', async () => {
		if (agentStatus) {
			agentStatus.textContent = 'sending…'
			agentStatus.dataset.state = 'sending'
		}
		try {
			await window.app.agent.send('Hello from the hello app.')
			if (agentStatus) {
				agentStatus.textContent = 'sent'
				agentStatus.dataset.state = 'sent'
			}
		} catch (err) {
			if (agentStatus) {
				agentStatus.textContent = `error: ${err?.message ?? err}`
				agentStatus.dataset.state = 'error'
			}
		}
	})
})
