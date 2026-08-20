/*
	Four ways out of a full-screen app. One mock app, one destination, four
	affordances — see `home-button.css` for the layout each one takes.

	Every stage is independent: `mount` is called once per `[data-dir]`, so the
	desktop frame and the phone frame of the same direction are two live copies
	that drag, idle and go home on their own.
*/

/* Icons come from the springboard study next door; the published page swaps in
   data URIs, since an artifact cannot fetch a file beside it. */
const ART = window.HB_ART || {
	draw: '../springboard/icon-draw.png',
	notes: '../springboard/icon-notes.png',
	paint: '../springboard/icon-paint.png'
}

const APPS = [
	{ name: 'Draw', art: 'draw' },
	{ name: 'Notes', art: 'notes', live: true },
	{ name: 'Paint', art: 'paint' },
	{ name: 'Files', hue: 1 },
	{ name: 'Tasks', hue: 4 },
	{ name: 'Reader', hue: 2 },
	{ name: 'Photos', hue: 5 },
	{ name: 'Calc', hue: 0 }
]

const art = (a) =>
	a.art
		? '<img class="ico" src="' + ART[a.art] + '" alt="" loading="lazy">'
		: '<span class="ico mono" data-hue="' + a.hue + '">' + a.name[0] + '</span>'

const BOARD =
	'<div class="find"><svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">' +
	'<circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
	'<path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>Search apps</div>' +
	'<div class="grid">' +
	APPS.map(
		(a) =>
			'<a class="tile" href="#"' + (a.live ? ' data-live' : '') + '>' +
			'<span class="art">' + art(a) + '</span><span class="nm">' + a.name + '</span></a>'
	).join('') +
	'</div>'

const glyph = (d) =>
	'<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>'

const DOTS = '<span class="dots"><i></i><i></i><i></i><i></i></span>'

/* The mock app. Furniture at both edges on purpose: the top bar is what a shelf
   competes with, the bottom bar is what a home indicator competes with. */
const APP =
	'<div class="appwin">' +
	'<header class="bar">' +
	'<span class="left"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M9.5 3 5 8l4.5 5"/></svg>All notes</span>' +
	'<span class="right">' +
	'<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10.5V2m0 0L5 5m3-3 3 3"/><path d="M2.5 9.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/></svg>' +
	'<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>' +
	'</span></header>' +
	'<div class="doc">' +
	'<h3>Kitchen rebuild</h3><p class="when">Edited 11 minutes ago</p>' +
	'<p>The plumber can only do the week of the 14th, so the tiling has to be booked after that or the wall opens twice. Ring the tiler before Friday and hold two days.</p>' +
	'<p>Worktop: the oak is warmer in the samples but the quote came back nearly double, and it wants oiling twice a year. Sticking with the composite unless the offcut looks bad in the actual light.</p>' +
	'<div class="todo">' +
	'<div><span class="box on">&check;</span><span>Measure the alcove properly</span></div>' +
	'<div><span class="box"></span><span>Ring the tiler</span></div>' +
	'<div><span class="box"></span><span>Return the oak sample</span></div>' +
	'</div>' +
	'<p>Left the old extractor in the plan for now. It is loud but it works, and moving the duct is its own job.</p>' +
	'<p>Sockets: two more on the island, one at counter height by the window. The sparky said that is a same-day change if it is decided before the plaster goes on.</p>' +
	'</div>' +
	'<footer class="tools"><b>B</b><b><i>I</i></b><b>U</b><span class="sep"></span>' +
	'<b>' + glyph('<path d="M3 4h1M3 8h1M3 12h1M6.5 4h6.5M6.5 8h6.5M6.5 12h6.5"/>') + '</b>' +
	'<b>' + glyph('<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M5.5 8.2 7.2 10l3.3-3.6"/>') + '</b>' +
	'<b>' + glyph('<rect x="2" y="3.5" width="12" height="9" rx="2"/><path d="m2.6 10.5 3.2-3 2.4 2.2 2.3-2.2 3 2.8"/>') + '</b>' +
	'</footer>' +
	'</div>'

const EXTRA = {
	d1: '<div class="gutter" data-grab><span class="pill"></span></div>',
	d2: '<button class="beacon" data-grab aria-label="Go to all apps">' + DOTS + '</button>',
	d3:
		'<div class="shelf">' +
		'<span class="art">' + art(APPS[1]) + '</span><span class="nm">Notes</span>' +
		'<span class="dot"></span><span class="who">justapps.run</span>' +
		'<button class="go" data-go>' + DOTS + 'Apps</button></div>',
	d4:
		'<span class="tell"></span><div class="grab" data-grab></div>' +
		'<div class="coach"><svg class="swipe" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8h10M9 4.5 12.5 8 9 11.5"/></svg>Swipe in from the edge for apps</div>'
}

/* ---- the trip, and the idle ---- */

const home = (s) => {
	s.dataset.home = '1'
	s.querySelector('.coach')?.classList.add('gone')
}
const back = (s) => delete s.dataset.home

/** Loud on contact, quiet after. What keeps d1 and d2 out of the way. */
function waker(s) {
	let timer
	return () => {
		s.classList.add('awake')
		clearTimeout(timer)
		timer = setTimeout(() => s.classList.remove('awake'), 2600)
	}
}

/**
 * One pointer gesture, reported as progress from 0 to 1. `read` turns the
 * distance moved into that progress, `paint` draws it, and a release past .38 —
 * or a tap that never moved — commits.
 */
function gesture(el, s, { read, paint, tap }) {
	el.addEventListener('pointerdown', (e) => {
		if (e.button) return
		el.setPointerCapture(e.pointerId)
		const x0 = e.clientX, y0 = e.clientY
		let p = 0, moved = false

		const move = (ev) => {
			const dx = ev.clientX - x0, dy = ev.clientY - y0
			if (!moved && Math.hypot(dx, dy) > 5) { moved = true; s.dataset.drag = '1' }
			if (!moved) return
			p = Math.max(0, Math.min(1, read(dx, dy)))
			paint(p, dx, dy)
		}
		const up = () => {
			el.removeEventListener('pointermove', move)
			el.removeEventListener('pointerup', up)
			el.removeEventListener('pointercancel', up)
			delete s.dataset.drag
			paint(null)
			if (!moved) tap?.()
			else if (p > .38) home(s)
		}
		el.addEventListener('pointermove', move)
		el.addEventListener('pointerup', up)
		el.addEventListener('pointercancel', up)
	})
}

function mount(s) {
	const dir = s.dataset.dir
	s.innerHTML =
		'<div class="board">' + BOARD + '</div><div class="pane">' +
		(dir === 'd3' ? EXTRA.d3 : '') + APP +
		(dir === 'd1' ? EXTRA.d1 : dir === 'd2' ? EXTRA.d2 : dir === 'd4' ? EXTRA.d4 : '') +
		'</div>'

	const pane = s.querySelector('.pane')
	const board = s.querySelector('.board')
	const wake = waker(s)

	// Tapping any icon on the springboard opens an app again, so the demo loops.
	board.addEventListener('click', (e) => { e.preventDefault(); back(s) })
	s.querySelector('[data-go]')?.addEventListener('click', () => home(s))

	/** Draw the app pane mid-gesture: it shrinks toward the board as it leaves. */
	const shrink = (p, dx, dy) => {
		if (p === null) { pane.style.transform = ''; board.style.opacity = ''; return }
		const t = dx === undefined ? '' : ` translate(${dx * .5}px, ${Math.min(0, dy) * .5}px)`
		pane.style.transform = `scale(${1 - p * .2})${t}`
		board.style.opacity = String(p * .9)
	}

	if (dir === 'd1') {
		const gutter = s.querySelector('.gutter')
		wake()
		gutter.addEventListener('pointerenter', wake)
		gesture(gutter, s, { read: (_, dy) => -dy / 90, paint: shrink, tap: () => home(s) })
	}

	if (dir === 'd2') {
		const orb = s.querySelector('.beacon')
		wake()
		s.addEventListener('pointermove', wake)
		let ox = 0, oy = 0
		orb.addEventListener('pointerdown', () => {
			ox = orb.offsetLeft
			oy = orb.offsetTop
			wake()
		})
		gesture(orb, s, {
			// The orb moves; the app never does. Dragging it is placing it, not leaving.
			read: () => 0,
			paint: (p, dx, dy) => {
				if (p === null) {
					// Released: snap to whichever side it is nearest, and stay in view.
					const mid = orb.offsetLeft + 21 > s.clientWidth / 2
					orb.style.setProperty('--bx', mid ? 'calc(100% - 60px)' : '18px')
					return
				}
				orb.style.setProperty('--bx', Math.max(8, Math.min(s.clientWidth - 50, ox + dx)) + 'px')
				orb.style.setProperty('--by', Math.max(8, Math.min(s.clientHeight - 50, oy + dy)) + 'px')
			},
			tap: () => home(s)
		})
	}

	if (dir === 'd3') {
		const doc = s.querySelector('.doc')
		let last = 0
		// Down through the note hides it; up, or a pointer reaching for the top, brings it back.
		doc.addEventListener('scroll', () => {
			const now = doc.scrollTop
			if (now > last + 4 && now > 24) s.classList.add('hid')
			else if (now < last - 4) s.classList.remove('hid')
			last = now
		})
		s.addEventListener('pointermove', (e) => {
			if (e.clientY - s.getBoundingClientRect().top < 46) s.classList.remove('hid')
		})
	}

	if (dir === 'd4') {
		const grab = s.querySelector('.grab')
		grab.addEventListener('pointerenter', wake)
		gesture(grab, s, { read: (dx) => dx / (s.clientWidth * .34), paint: shrink })
		const coach = s.querySelector('.coach')
		s.addEventListener('pointerenter', () => setTimeout(() => coach.classList.add('gone'), 3600), { once: true })
		// And goes for good the moment the gesture has worked once.
		s.addEventListener('pointerup', () => { if (s.dataset.home) coach.classList.add('gone') })
	}
}

document.querySelectorAll('[data-dir]').forEach(mount)

// Escape is the desktop way out of any of them, on whichever stage the pointer is over.
let over = null
document.addEventListener('pointerover', (e) => { over = e.target.closest('[data-dir]') || over })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && over) home(over) })
