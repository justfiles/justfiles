const el = document.getElementById('time')
const status = document.getElementById('status')
const last = document.getElementById('last')
const tick = () => {
	if (el) el.textContent = new Date().toLocaleTimeString()
}
tick()
setInterval(tick, 1000)

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
})
