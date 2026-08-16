const APPS = [
	{
		"name": "Draw",
		"id": "justfiles.draw",
		"version": "0.4.2",
		"about": "A freeform sketchpad backed by Excalidraw",
		"art": "draw",
		"hue": 0
	},
	{
		"name": "Notes",
		"id": "justfiles.notes",
		"version": "0.1.0",
		"about": "A freeform knowledge base shared with the agent",
		"art": "notes",
		"hue": 5
	},
	{
		"name": "Paint",
		"id": "justfiles.paint",
		"version": "0.1.0",
		"about": "Pixel drawing",
		"art": "paint",
		"hue": 3
	},
	{
		"name": "Files",
		"id": "justfiles.files",
		"version": "0.3.1",
		"about": "Browse the volume",
		"hue": 1
	},
	{
		"name": "Tasks",
		"id": "justfiles.tasks",
		"version": "0.2.0",
		"about": "A checklist that syncs",
		"hue": 4
	},
	{
		"name": "Reader",
		"id": "justfiles.reader",
		"version": "0.1.4",
		"about": "Saved articles, offline",
		"hue": 2
	},
	{
		"name": "Photos",
		"id": "justfiles.photos",
		"version": "0.2.2",
		"about": "The camera roll, local first",
		"hue": 5
	},
	{
		"name": "Calc",
		"id": "justfiles.calc",
		"version": "0.1.0",
		"about": "A tape calculator",
		"hue": 0
	},
	{
		"name": "Terminal",
		"id": "justfiles.terminal",
		"version": "0.5.0",
		"about": "A shell against the volume",
		"hue": 1
	},
	{
		"name": "Chess",
		"id": "justfiles.chess",
		"version": "0.1.1",
		"about": "Play a game, or watch one",
		"hue": 3
	},
	{
		"name": "Timer",
		"id": "justfiles.timer",
		"version": "0.1.0",
		"about": "Timers and a stopwatch",
		"hue": 4
	},
	{
		"name": "Weather",
		"id": "justfiles.weather",
		"version": "0.2.1",
		"about": "The forecast, cached",
		"hue": 2
	}
]

const DOCK = ["Notes","Draw","Files","Terminal"]

const art = (app) =>
	app.art
		? '<img class="ico" src="icon-' + app.art + '.png" alt="" loading="lazy">'
		: '<span class="ico mono" data-hue="' + app.hue + '">' + app.name[0] + '</span>'

const TILE = {
	v1: (a) => '<a class="tile" href="#"><span class="art">' + art(a) + '</span><span class="nm">' + a.name + '</span></a>',

	v2: (a) =>
		'<a class="tile" href="#"><span class="art">' + art(a) + '</span>' +
		'<span class="nm">' + a.name + '</span><span class="ver">' + a.version + '</span>' +
		'<span class="go">&crarr;</span></a>',

	v3: (a) =>
		'<a class="cell" href="#">' + art(a) +
		'<span class="txt"><span class="nm">' + a.name + '</span>' +
		'<span class="ab">' + a.about + '</span></span></a>',

	v4: (a) =>
		'<a class="tile" href="#" data-hue="' + a.hue + '"><span class="chip">' + art(a) + '</span>' +
		'<span class="foot"><span class="nm">' + a.name + '</span><span class="ver">' + a.version + '</span></span></a>',

	v5: (a) => '<a class="tile" href="#"><span class="art">' + art(a) + '</span><span class="nm">' + a.name + '</span></a>'
}

const hay = (a) => (a.name + ' ' + a.id + ' ' + a.about).toLowerCase()

/** One stage: its own input, its own grid. Two stages of the same variant filter independently. */
function mount(stage) {
	const variant = stage.dataset.variant
	const grid = stage.querySelector('[data-grid]')
	const input = stage.querySelector('input')
	const empty = stage.querySelector('[data-empty]')
	const count = stage.querySelector('[data-count]')
	const dock = stage.querySelector('[data-dock]')

	if (dock) dock.innerHTML = DOCK.map((name) => art(APPS.find((a) => a.name === name))).join('')

	const draw = () => {
		const q = input.value.trim().toLowerCase()
		const hits = q ? APPS.filter((a) => hay(a).includes(q)) : APPS
		grid.innerHTML = hits.map(TILE[variant]).join('')
		if (empty) {
			empty.hidden = hits.length > 0
			empty.textContent = 'Nothing here matches \u201C' + input.value.trim() + '\u201D.'
		}
		if (count) count.textContent = hits.length === APPS.length ? APPS.length + ' apps' : hits.length + ' of ' + APPS.length
	}

	input.addEventListener('input', draw)
	// The tiles are mock links; keep a click from jumping the page to the top.
	grid.addEventListener('click', (e) => e.preventDefault())
	draw()
}

document.querySelectorAll('[data-variant]').forEach(mount)
