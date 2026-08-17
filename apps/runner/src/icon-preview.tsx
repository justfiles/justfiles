import type { Handler } from 'hono'
import { raw } from 'hono/html'
import { readStore } from './catalog'
import type { StoreApp } from './protocol'

type Env = { Bindings: CloudflareBindings }

/**
 * The icon proving ground: drop one image in, and see it in every surface that
 * will ever draw it — the Frieren omnibar, this store's own omnibar and home
 * grid, and the installed "native" icon each OS masks its own way.
 *
 * Client-only. The file never leaves the page (one object URL, handed to every
 * `<img>`), so trying a candidate costs no publish and no store write — which is
 * the whole point of a preview.
 *
 * The mocks copy the real geometry rather than load it: the numbers below come
 * from `apps/frieren/src/app.css`, `home.tsx` and `packages/design`, each noted
 * where it lands. A copy can drift; the alternative is pulling another app's
 * stylesheet into this page and inheriting its layout with it.
 */

/**
 * One icon well: the dropped image, over the monogram every surface falls back to
 * when an app publishes no icon. Given a published app instead, it draws that
 * app — so the candidate is judged beside the icons it will stand next to.
 */
const Icon = ({ cls, app }: { cls: string; app?: StoreApp }) =>
	app ? (
		<span class={cls}>
			{app.iconUrl ? <img src={app.iconUrl} alt="" /> : <span>{app.name.slice(0, 1)}</span>}
		</span>
	) : (
		<span class={cls}>
			<img data-icon="true" alt="" />
			<span class="letter">A</span>
		</span>
	)

/** An app's name beside its icon: the dropped one follows the name field. */
const Name = ({ cls, app }: { cls?: string; app?: StoreApp }) => (
	<span class={cls} data-name={app ? undefined : 'true'}>
		{app?.name ?? 'Your App'}
	</span>
)

const STYLE = `
:root { --page: #eceef3; --ink: #1b1f26; --dim: #6d7481; --card: #fff; --edge: rgba(24,32,56,.13);
	/* Design tokens, light — packages/design/design.css */
	--surface: #f5f5f4; --text: #1c1c1c; --rule: #d0d0cd; --focus: #0a84ff; --on-focus: #fff;
	/* Springboard palette, light — home.tsx */
	--wash: rgba(255,209,163,.5); --bg1: #eef1f6; --bg2: #dfe5ef; --sb-ink: #1b1f26;
	--pill: rgba(255,255,255,.72); --sb-edge: rgba(24,32,56,.10); --cast: rgba(24,32,56,.18) }
html { background: var(--page); color: var(--ink); color-scheme: light;
	font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif }
html[data-theme="dark"] { color-scheme: dark;
	--page: #14161a; --ink: #e9ebf1; --dim: #949bab; --card: #1d2026; --edge: rgba(255,255,255,.12);
	--surface: #2c2c2e; --text: #ebebf0; --rule: #3a3a3c;
	--wash: rgba(96,116,190,.28); --bg1: #171a20; --bg2: #0d0f13; --sb-ink: #eceef3;
	--pill: rgba(255,255,255,.06); --sb-edge: rgba(255,255,255,.12); --cast: rgba(0,0,0,.6) }
body { margin: 0 auto; max-width: 820px; padding: 28px 22px 80px }
h1 { font-size: 20px; margin: 0 0 4px }
h2 { font-size: 14px; letter-spacing: .02em; margin: 0; text-transform: uppercase }
p { color: var(--dim); font-size: 13px; margin: 0 }

/* The controls: a drop target that is the whole page, plus the two things that
   change what the mocks say — the name under every icon, and the theme every
   surface is drawn in. */
.top { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; margin: 14px 0 26px }
.top label { align-items: center; border: 1px solid var(--edge); border-radius: 8px;
	background: var(--card); display: inline-flex; font-size: 13px; gap: 8px; padding: 7px 10px }
input[type="text"] { background: none; border: 0; color: inherit; font: inherit; font-size: 13px;
	outline: none; width: 9ch }
input[type="file"] { font-size: 12px; max-width: 190px }
button { background: var(--card); border: 1px solid var(--edge); border-radius: 8px; color: inherit;
	font: inherit; font-size: 13px; padding: 7px 12px }
.meta { color: var(--dim); font-size: 12.5px; margin-left: auto }
.meta b { color: #c0392b; font-weight: 600 }
html[data-theme="dark"] .meta b { color: #ff6b5a }
/* The one untouched view: no mask, no crop, on a checkerboard — so transparent
   padding, which every surface below hides or fills, is visible once. */
.raw { background-image: linear-gradient(45deg, var(--edge) 25%, transparent 25% 75%, var(--edge) 75%),
		linear-gradient(45deg, var(--edge) 25%, transparent 25% 75%, var(--edge) 75%);
	background-position: 0 0, 6px 6px; background-size: 12px 12px; border: 1px solid var(--edge);
	border-radius: 8px; flex: none; height: 44px; width: 44px }
.raw img { height: 100%; object-fit: contain; width: 100% }

/* Every well hides one of its two children: the image once there is one, the
   monogram until then. */
[data-icon] { display: none }
body[data-loaded] [data-icon] { display: block }
body[data-loaded] .letter { display: none }
body[data-drag]::after { border: 3px dashed var(--focus); border-radius: 18px; content: "";
	inset: 10px; pointer-events: none; position: fixed; z-index: 99 }

section { margin-bottom: 34px }
.head { align-items: baseline; display: flex; gap: 10px; margin-bottom: 10px }
/* Each mock sits on the ground its surface actually sits on: a pill over a
   desktop reads nothing like a pill over paper. */
.ground { border: 1px solid var(--edge); border-radius: 14px; display: grid; gap: 22px;
	justify-items: center; overflow: hidden; padding: 26px 20px }
.ground[data-ground="desktop"] { background:
	radial-gradient(ellipse at 50% 30%, rgba(255,255,255,.1), transparent 62%), #3a6b8c }
.ground[data-ground="springboard"] { background:
	radial-gradient(110% 70% at 50% -8%, var(--wash), transparent 62%),
	linear-gradient(180deg, var(--bg1), var(--bg2)); color: var(--sb-ink) }
.ground[data-ground="os"] { background: linear-gradient(160deg, #5b4b8a, #2b6ea8 60%, #1f8a8a) }
.cap { color: var(--dim); font-size: 12.5px; margin-top: 8px }

/* ── 1 · Frieren omnibar — apps/frieren/src/app.css ──────────────────────── */
.frn { background: color-mix(in srgb, var(--surface) 92%, transparent);
	backdrop-filter: blur(30px) saturate(180%); border: 1px solid var(--rule); border-radius: 16px;
	box-shadow: 0 16px 48px rgba(0,0,0,.32); color: var(--text); font-size: 13px;
	overflow: hidden; width: min(640px, 100%) }
.frn-surface { border-bottom: 1px solid var(--rule) }
.frn-grid { display: grid; gap: 4px; grid-template-columns: repeat(5, minmax(0, 1fr)); padding: 12px }
.frn-tile { align-items: center; display: flex; flex-direction: column; gap: 6px; padding: 10px 4px }
.frn-tile-name { font-size: 12px; max-width: 100%; overflow: hidden; text-align: center;
	text-overflow: ellipsis; white-space: nowrap }
.frn-icon, .frn-icon-sm { align-items: center; background: linear-gradient(145deg,
		color-mix(in srgb, var(--text) 22%, transparent), color-mix(in srgb, var(--text) 6%, transparent));
	border-radius: 12px; display: flex; font-size: 22px; font-weight: 650; height: 52px;
	justify-content: center; overflow: hidden; width: 52px }
.frn-icon img, .frn-icon-sm img { height: 100%; object-fit: cover; width: 100% }
.frn-icon-sm { border-radius: 7px; font-size: 13px; height: 26px; width: 26px }
.frn-list { list-style: none; margin: 0; padding: 6px }
.frn-row { align-items: center; border-radius: 9px; display: flex; gap: 10px; padding: 7px 10px }
.frn-row[data-selected] { background: var(--focus); color: var(--on-focus) }
.frn-row-desc { font-size: 12px; opacity: .58 }
.frn-row[data-selected] .frn-row-desc { opacity: .85 }
.frn-section { font-size: 11px; font-weight: 650; letter-spacing: .04em; margin: 5px 10px 3px;
	opacity: .5; text-transform: uppercase }
.frn-bar { align-items: center; display: flex; font-size: 16px; gap: 10px; min-height: 48px;
	opacity: .55; padding: 7px 16px }
/* The agent's resting chip, only so the pill's left inset is honest. */
.frn-face { background: color-mix(in srgb, var(--text) 18%, transparent); border-radius: 50%;
	flex: none; height: 32px; opacity: .8; width: 32px }

/* ── 2 · This store's omnibar — the search pill from home.tsx, with the
      result row a query resolves to ─────────────────────────────────────── */
.sb-find { align-items: center; backdrop-filter: blur(20px) saturate(1.4); background: var(--pill);
	border: 1px solid var(--sb-edge); border-radius: 999px; box-shadow: 0 1px 2px var(--cast);
	display: flex; gap: 9px; padding: 10px 16px; width: min(340px, 100%) }
.sb-find span { font-size: 14.5px; opacity: .75 }
.sb-hits { backdrop-filter: blur(20px) saturate(1.4); background: var(--pill);
	border: 1px solid var(--sb-edge); border-radius: 16px; box-shadow: 0 8px 18px -6px var(--cast);
	display: grid; gap: 2px; padding: 8px; width: min(340px, 100%) }
.sb-hit { align-items: center; display: flex; gap: 10px; padding: 6px 8px }
.sb-hit-icon { align-items: center; background: color-mix(in srgb, var(--sb-ink) 12%, transparent);
	border-radius: 9px; display: flex; flex: none; font-size: 15px; font-weight: 600; height: 34px;
	justify-content: center; overflow: hidden; width: 34px }
.sb-hit-icon img { height: 100%; object-fit: cover; width: 100% }
.sb-hit-name { font-size: 13.5px }

/* ── 3 · The installed icon — one image, three masks ─────────────────────── */
.os { display: flex; flex-wrap: wrap; gap: 30px; justify-content: center; text-align: center }
.os figure { margin: 0; width: 168px }
.os figcaption { color: rgba(255,255,255,.8); font-size: 11.5px; margin-top: 10px }
.os-label { color: #fff; display: block; font-size: 11px; margin-top: 6px;
	text-shadow: 0 1px 2px rgba(0,0,0,.5) }
.ios, .droid, .dock-icon { align-items: center; background: rgba(255,255,255,.9); color: #333;
	display: flex; font-size: 26px; font-weight: 600; height: 60px; justify-content: center;
	margin: 0 auto; overflow: hidden; width: 60px }
.ios img, .droid img, .dock-icon img { height: 100%; object-fit: cover; width: 100% }
/* iOS/iPadOS: the superellipse, applied to whatever you ship. */
.ios { border-radius: 13.4px; box-shadow: 0 4px 10px rgba(0,0,0,.35) }
/* Android: an icon that does not declare purpose "maskable" is dropped whole
   into a white circle, so a full-bleed design loses its corners and a padded one
   shrinks. Ours declares "any" only (see app.tsx) — this is what that means. */
.droid { border-radius: 50%; box-shadow: 0 4px 10px rgba(0,0,0,.35); padding: 9px }
.droid img { border-radius: 4px }
/* macOS: a browser-installed app gets no mask at all — a square PNG stays a
   square tile in the dock. */
.dock { align-items: flex-end; backdrop-filter: blur(14px); background: rgba(255,255,255,.24);
	border: 1px solid rgba(255,255,255,.3); border-radius: 22px; display: flex; gap: 10px;
	padding: 8px 12px }
.dock-icon { border-radius: 0; box-shadow: 0 6px 12px rgba(0,0,0,.35); height: 52px; width: 52px }

/* ── 4 · The home grid — home.tsx ────────────────────────────────────────── */
.sb-grid { display: grid; gap: 30px 16px; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
	width: 100% }
.sb-app { display: grid; gap: 9px; justify-items: center }
.sb-icon { align-items: center; background: color-mix(in srgb, var(--sb-ink) 12%, transparent);
	border-radius: 22px; box-shadow: 0 8px 18px -6px var(--cast); color: var(--sb-ink);
	display: flex; font-size: 30px; font-weight: 600; height: 74px; justify-content: center;
	overflow: hidden; width: 74px }
.sb-icon img { height: 100%; object-fit: cover; width: 100% }
.sb-name { font-size: 12.5px; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
	white-space: nowrap }
/* The phone home screen: four fixed columns and a smaller tile, per home.tsx.
   Framed, because at this width the only difference from the grid above is the
   geometry — and that is the thing being judged. */
.phone { border: 8px solid color-mix(in srgb, var(--sb-ink) 55%, transparent); border-radius: 34px;
	padding: 26px 14px; width: 322px }
.phone .sb-grid { gap: 26px 6px; grid-template-columns: repeat(4, minmax(0, 1fr)); width: 100% }
.phone .sb-icon { border-radius: 18px; height: 62px; width: 62px }
`

/**
 * Everything the page does: hand one local file to every `<img>`, and keep the
 * name and theme in sync. No fetch, no upload — the object URL is the whole
 * mechanism, so the bytes stay in the tab.
 */
const SCRIPT = `
const meta = document.querySelector('.meta')
const show = (file) => {
	if (!file || !file.type.startsWith('image/')) return
	const url = URL.createObjectURL(file)
	for (const img of document.querySelectorAll('[data-icon]')) img.src = url
	document.body.dataset.loaded = 'true'
	const probe = new Image()
	probe.onload = () => {
		const { naturalWidth: w, naturalHeight: h } = probe
		const warn = w !== h ? 'not square' : Math.min(w, h) < 512 ? 'under 512px' : ''
		meta.innerHTML = file.name + ' · ' + w + '×' + h + (warn ? ' · <b>' + warn + '</b>' : '')
	}
	probe.src = url
}
document.querySelector('input[type=file]').addEventListener('change', (e) => show(e.target.files[0]))
document.addEventListener('paste', (e) => show(e.clipboardData.files[0]))
addEventListener('dragover', (e) => { e.preventDefault(); document.body.dataset.drag = 'true' })
addEventListener('dragleave', () => delete document.body.dataset.drag)
addEventListener('drop', (e) => {
	e.preventDefault()
	delete document.body.dataset.drag
	show(e.dataTransfer.files[0])
})

const name = document.querySelector('input[type=text]')
name.addEventListener('input', () => {
	for (const el of document.querySelectorAll('[data-name]')) el.textContent = name.value
	for (const el of document.querySelectorAll('.letter'))
		el.textContent = (name.value.trim().slice(0, 1) || 'A').toUpperCase()
})

// Starts on the system theme, then follows the button — both surfaces below are
// themed, and an icon that reads on one ground can disappear on the other.
const theme = document.querySelector('.theme')
const set = (mode) => {
	document.documentElement.dataset.theme = mode
	theme.textContent = mode === 'dark' ? 'Light' : 'Dark'
}
set(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
theme.addEventListener('click', () =>
	set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
)
`

export const iconPreview: Handler<Env> = async (c) => {
	// The candidate first, then the live store behind it — an icon is only ever seen
	// among others, so `undefined` (yours) leads and the published apps follow.
	const apps: (StoreApp | undefined)[] = [undefined, ...(await readStore(c.env)).apps.slice(0, 4)]

	return c.html(
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>Icon preview</title>
				<style>{raw(STYLE)}</style>
			</head>
			<body>
				<h1>Icon preview</h1>
				<p>
					Drop an image anywhere on this page — or paste one — to see it in every surface that draws
					an app icon. Nothing is uploaded; the file stays in this tab.
				</p>
				<div class="top">
					<label>
						<input type="file" accept="image/*" />
					</label>
					<label>
						Name
						<input type="text" value="Your App" spellcheck={false} />
					</label>
					<button type="button" class="theme">
						Dark
					</button>
					<span class="meta">No image yet</span>
					<span class="raw" title="As delivered">
						<img data-icon="true" alt="" />
					</span>
				</div>

				<section>
					<div class="head">
						<h2>1 · Frieren omnibar</h2>
						<p>52px tile, 26px row · 12px and 7px radius</p>
					</div>
					<div class="ground" data-ground="desktop">
						<div class="frn">
							<div class="frn-surface">
								<div class="frn-grid">
									{apps.map((app) => (
										<span class="frn-tile">
											<Icon cls="frn-icon" app={app} />
											<Name cls="frn-tile-name" app={app} />
										</span>
									))}
								</div>
							</div>
							<div class="frn-bar">
								<span class="frn-face"></span>
								<span>Search apps, or talk to Frieren…</span>
							</div>
						</div>
						<div class="frn">
							<div class="frn-surface">
								<ul class="frn-list">
									<li class="frn-section">On this computer</li>
									{apps.map((app) => (
										/* The top hit is the selected row, where the icon sits on the accent —
										   the one ground in the shell that is neither light nor dark. */
										<li class="frn-row" data-selected={app ? undefined : 'true'}>
											<Icon cls="frn-icon-sm" app={app} />
											<span>
												<Name app={app} />
												{app ? null : <span class="frn-row-desc"> · your app’s description</span>}
											</span>
										</li>
									))}
								</ul>
							</div>
							<div class="frn-bar">
								<span class="frn-face"></span>
								<span>your app</span>
							</div>
						</div>
					</div>
					<p class="cap">
						The shell rounds and crops for you: the well clips to its own radius and the image is
						drawn <code>cover</code>, so a square icon loses only its corners.
					</p>
				</section>

				<section>
					<div class="head">
						<h2>2 · {c.env.ROOT_DOMAIN} omnibar</h2>
						<p>34px hit · 9px radius</p>
					</div>
					<div class="ground" data-ground="springboard">
						<div class="sb-find">
							<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
								<circle
									cx="7"
									cy="7"
									r="4.5"
									fill="none"
									stroke="currentColor"
									stroke-width="1.6"
								/>
								<path
									d="M10.5 10.5 14 14"
									stroke="currentColor"
									stroke-width="1.6"
									stroke-linecap="round"
								/>
							</svg>
							<span data-name="true">Your App</span>
						</div>
						<div class="sb-hits">
							{apps.map((app) => (
								<div class="sb-hit">
									<Icon cls="sb-hit-icon" app={app} />
									<Name cls="sb-hit-name" app={app} />
								</div>
							))}
						</div>
					</div>
					<p class="cap">
						The smallest the icon ever gets on this origin — whatever is left of the artwork here is
						all a search result carries.
					</p>
				</section>

				<section>
					<div class="head">
						<h2>3 · Installed app icon</h2>
						<p>one image, three masks</p>
					</div>
					<div class="ground" data-ground="os">
						<div class="os">
							<figure>
								<Icon cls="ios" />
								<span class="os-label" data-name="true">
									Your App
								</span>
								<figcaption>iOS home screen — squircle, full bleed</figcaption>
							</figure>
							<figure>
								<Icon cls="droid" />
								<span class="os-label" data-name="true">
									Your App
								</span>
								<figcaption>
									Android — no maskable icon declared, so it goes whole into a circle
								</figcaption>
							</figure>
							<figure>
								<div class="dock">
									{apps.slice(0, 3).map((app) => (
										<Icon cls="dock-icon" app={app} />
									))}
								</div>
								<figcaption>macOS dock — no mask at all, the PNG as shipped</figcaption>
							</figure>
						</div>
					</div>
					<p class="cap">
						This is where a design has to choose: corners the OS will cut anyway, and a circle that
						will eat the edges on Android.
					</p>
				</section>

				<section>
					<div class="head">
						<h2>4 · {c.env.ROOT_DOMAIN} home</h2>
						<p>74px tile, 62px on a phone · 22px and 18px radius</p>
					</div>
					<div class="ground" data-ground="springboard">
						<div class="sb-grid">
							{apps.map((app) => (
								<span class="sb-app">
									<Icon cls="sb-icon" app={app} />
									<Name cls="sb-name" app={app} />
								</span>
							))}
						</div>
						<div class="phone">
							<div class="sb-grid">
								{apps.slice(0, 4).map((app) => (
									<span class="sb-app">
										<Icon cls="sb-icon" app={app} />
										<Name cls="sb-name" app={app} />
									</span>
								))}
							</div>
						</div>
					</div>
					<p class="cap">
						The grid is the first thing a visitor sees, and the only one they compare.
					</p>
				</section>
				<script>{raw(SCRIPT)}</script>
			</body>
		</html>
	)
}
