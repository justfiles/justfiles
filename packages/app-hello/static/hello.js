const el = document.getElementById('time')
const status = document.getElementById('status')
const tick = () => {
	if (el) el.textContent = new Date().toLocaleTimeString()
}
tick()
setInterval(tick, 1000)

window.app?.lifecycle.onStart(() => {
	if (!status) return
	status.textContent = `started · app sdk v${window.app.version}`
	status.dataset.started = 'true'
})
