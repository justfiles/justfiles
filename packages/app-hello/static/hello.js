const el = document.getElementById('time')
const tick = () => {
	if (el) el.textContent = new Date().toLocaleTimeString()
}
tick()
setInterval(tick, 1000)
