const timeEl = document.getElementById('time')
const status = document.getElementById('status')
const note = document.getElementById('note')
const saveBtn = document.getElementById('save')
const savedAt = document.getElementById('saved-at')

const tick = () => {
	if (timeEl) timeEl.textContent = new Date().toLocaleTimeString()
}
tick()
setInterval(tick, 1000)

const NOTE_PATH = 'note.txt'

const setSavedLabel = (text) => {
	if (savedAt) savedAt.textContent = text
}

window.app?.lifecycle.onStart(async () => {
	if (!status) return
	status.textContent = `started · app sdk v${window.app.version}`
	status.dataset.started = 'true'

	try {
		const existing = await window.app.volume.readText(NOTE_PATH)
		if (note) note.value = existing
		setSavedLabel('loaded from volume')
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		if (message.startsWith('ENOENT')) setSavedLabel('no note saved yet')
		else setSavedLabel(`load failed: ${message}`)
	}

	saveBtn?.addEventListener('click', async () => {
		if (!note) return
		setSavedLabel('saving…')
		try {
			await window.app.volume.writeText(NOTE_PATH, note.value)
			setSavedLabel(`saved · ${new Date().toLocaleTimeString()}`)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			setSavedLabel(`save failed: ${message}`)
		}
	})
})
