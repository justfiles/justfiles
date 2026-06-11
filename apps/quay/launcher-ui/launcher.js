// Phase 0: the launcher list is mocked here. Phase 1 replaces this with a list
// fetched from quayd over the socket. Picking a tile asks the native shell to
// launch that app's .app bundle (window.quay is injected by Launcher.swift).

const apps = [
	{ id: 'code', name: 'Code', glyph: 'C' },
	{ id: 'finder', name: 'Finder', glyph: 'F' },
	{ id: 'paint', name: 'Paint', glyph: 'P' }
]

const grid = document.getElementById('grid')
const search = document.getElementById('search')

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

search.addEventListener('input', () => render(search.value))
search.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && window.quay) window.quay.hide()
	if (e.key === 'Enter') {
		const first = grid.querySelector('.tile')
		if (first) first.click()
	}
})

render()
search.focus()
