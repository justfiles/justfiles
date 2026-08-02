import type { Client } from '@justfiles/app'
import { injectStyle } from '@justfiles/app/browser'
import { imageDataUrl } from '@justfiles/app/image-type'
import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import { normalizeHex, type SettingsApp, WALLPAPER_COLORS } from './app.ts'

// The Appearance pane: the desktop's own look, previewed before you commit to it.
//
// TWO PARTS, AND THE ORDER IS THE POINT. On top, a SIMULATION of the shell — a menubar
// strip, two ghost windows, a simplified omnibar pill — because the question a wallpaper
// answers is not "is this a nice colour" but "can I still read my work on it". Under it,
// ONE ROW: the quiet presets, then the two ways of going off-menu (any colour, your own
// picture) as the last two tiles of the same row, because they are answers to the same
// question and not separate features. The words live in the caption, so no tile needs a
// label.
//
// NOTHING HERE IS REDUCER STATE. A wallpaper is bytes on the Volume (`app.ts`: a colour
// is a file too), so this pane reads the file once and thereafter knows what it wrote —
// see `readWallpaper`. That is also why the pane holds a `File`'s bytes only long enough
// to send them.

injectStyle(
	`
.wp { display: flex; flex-direction: column; align-items: center; }

/* The simulation. Everything inside scales off the container's width, so the same
   markup works at any pane width — it is never the real menubar or omnibar. */
.wp-mini { container-type: inline-size; position: relative; width: 100%; aspect-ratio: 16 / 10; overflow: hidden; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--text) 18%, transparent); user-select: none; }
/* The type scale is on the CHILDREN, not on the container: a container query unit used ON
   the container it would query resolves against the viewport instead (the spec breaks that
   circularity), which sized this simulation off the window rather than off itself. */
.wp-mini > * { font-size: 2.6cqw; }
.wp-field { position: absolute; inset: 0; background: var(--desktop-bg); background-size: cover; background-position: center; }
.wp-bar { position: relative; z-index: 2; display: flex; align-items: center; justify-content: space-between; height: 5.5cqw; padding: 0 2cqw; background: var(--surface); color: var(--text); border-bottom: 1px solid var(--rule); }
.wp-bar-group { display: flex; align-items: center; gap: 1.8cqw; }
.wp-bar-title { font-weight: 500; }
.wp-quiet { opacity: 0.6; }
.wp-dot { width: 0.5em; height: 0.5em; border-radius: 999px; background: #22c55e; }
.wp-avatar { width: 1.3em; height: 1.3em; border-radius: 999px; background: color-mix(in srgb, var(--text) 25%, transparent); }
.wp-win { position: absolute; border-radius: 0.5em; overflow: hidden; border: 1px solid rgba(255,255,255,0.28); background: var(--window-bg); box-shadow: 0 0.5em 1.4em rgba(0,0,0,0.3); }
.wp-win[data-i="0"] { left: 8%; top: 22%; width: 40%; }
.wp-win[data-i="1"] { left: 34%; top: 38%; width: 44%; }
.wp-win-bar { display: flex; align-items: center; gap: 0.3em; height: 1.6em; padding: 0 0.4em; background: var(--surface); border-bottom: 1px solid var(--rule); }
.wp-win-bar i { width: 0.45em; height: 0.45em; border-radius: 999px; background: color-mix(in srgb, var(--text) 30%, transparent); }
.wp-win-body { display: flex; flex-direction: column; gap: 0.4em; padding: 0.6em; }
.wp-win-body b { display: block; height: 0.35em; border-radius: 999px; background: color-mix(in srgb, var(--text) 16%, transparent); }
.wp-win-body b:nth-child(2) { width: 70%; }
.wp-win-body b:nth-child(3) { width: 85%; }
.wp-win-body b:nth-child(4) { width: 45%; }
.wp-omni { position: absolute; left: 50%; bottom: 3.5cqw; transform: translateX(-50%); display: flex; align-items: center; gap: 0.6em; width: 66%; height: 7.5cqw; padding: 0 0.8em; border-radius: 1em; border: 1px solid var(--rule); color: var(--text); background: color-mix(in srgb, var(--surface) 88%, transparent); backdrop-filter: blur(12px) saturate(180%); box-shadow: 0 0.4em 1.2em rgba(0,0,0,0.3); }
.wp-omni-face { flex: none; width: 1.5em; height: 1.5em; border-radius: 999px; border: 1px solid rgba(255,255,255,0.6); background: linear-gradient(145deg, #c4b5fd, #7c9ec9); }
.wp-omni-ph { flex: 1; opacity: 0.45; }
.wp-omni-key { opacity: 0.35; font-family: var(--font-mono); }

/* The tray: one frosted row, off the wallpaper. Dark in both themes on purpose — it
   reads as an instrument rather than as part of the page. */
.wp-tray { display: flex; align-items: center; gap: 8px; margin-top: 14px; padding: 8px 10px; border-radius: 14px; color: #fff; background: rgba(28,28,30,0.55); border: 1px solid rgba(255,255,255,0.22); box-shadow: 0 10px 26px rgba(0,0,0,0.3); backdrop-filter: blur(18px) saturate(180%); }
.wp-chips { display: flex; gap: 6px; }
.wp-tile { position: relative; flex: none; width: 30px; height: 30px; padding: 0; border-radius: 8px; border: 1px solid rgba(255,255,255,0.32); background-size: cover; background-position: center; transition: transform 100ms ease; }
.wp-tile:hover { transform: translateY(-1px); }
.wp-tile[aria-pressed="true"], .wp-pick[data-on="true"] { box-shadow: 0 0 0 2px rgba(0,0,0,0.4), 0 0 0 3.5px #fff; }
.wp-check { position: absolute; inset: 0; display: grid; place-items: center; font-size: 13px; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,0.7); opacity: 0; }
.wp-tile[aria-pressed="true"] .wp-check { opacity: 1; }
/* A tick on a pale swatch has to go dark. */
.wp-tile[data-light="true"] .wp-check { color: #2b2b2b; text-shadow: none; }
.wp-sep { flex: none; width: 1px; height: 26px; background: rgba(255,255,255,0.42); }
/* The conic ring says "any colour" so the well needs no label; the native input does the work. */
.wp-well { position: relative; flex: none; width: 30px; height: 30px; padding: 2px; overflow: hidden; border-radius: 8px; background: conic-gradient(#ff6b6b, #ffd93d, #6bcb77, #4d96ff, #b57bff, #ff6b6b); }
.wp-well input { width: 100%; height: 100%; padding: 0; border: 0; border-radius: 6px; background: none; }
.wp-well input::-webkit-color-swatch-wrapper { padding: 0; }
.wp-well input::-webkit-color-swatch { border: none; border-radius: 6px; }
.wp-well[data-on="true"] { outline: 2px solid #fff; outline-offset: 2px; }
/* Your picture: a dashed tile until one is set, then it IS the thumbnail. */
.wp-pick { display: grid; place-items: center; border-style: dashed; border-color: rgba(255,255,255,0.5); background: rgba(255,255,255,0.12); font-size: 15px; cursor: default; }
.wp-pick[data-has="true"] { border-style: solid; }
.wp-pick input { display: none; }
.wp-caption { font-size: 11px; opacity: 0.55; font-variant-numeric: tabular-nums; }
.wp-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; margin-top: 10px; }
`,
	'app-settings-appearance'
)

// What the pane knows about the current wallpaper: a colour, a picture (as the data URL it
// shows), or neither — the shell's own default.
type Wallpaper = { color: string | null; image: string | null }

const NONE: Wallpaper = { color: null, image: null }

// The words under the tray. `Default` is a real answer, not an empty one: it is what
// Reset goes back to, and what a device that never set one is showing.
function caption(wallpaper: Wallpaper): string {
	if (wallpaper.image) return 'Your picture'
	if (!wallpaper.color) return 'Default'
	const preset = WALLPAPER_COLORS.find((c) => c.hex === wallpaper.color)
	return `${preset?.name ?? 'Custom'} · ${wallpaper.color.toUpperCase()}`
}

// Light enough that a white tick would vanish on it.
function isLight(hex: string): boolean {
	const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
	return 0.299 * (r ?? 0) + 0.587 * (g ?? 0) + 0.114 * (b ?? 0) > 150
}

export function AppearancePane({ client }: { client: Client<SettingsApp> }) {
	const [wallpaper, setWallpaper] = useState<Wallpaper>(NONE)
	// A host whose shell has no wallpaper (the Mac app today) reports the methods
	// unavailable — say so, the way the Usage pane does with no meter.
	const [unavailable, setUnavailable] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const loaded = useRef(false)

	useEffect(() => {
		if (loaded.current) return
		loaded.current = true
		client
			.readWallpaper({})
			.then(setWallpaper)
			.catch((e: unknown) => {
				const message = e instanceof Error ? e.message : String(e)
				if (message.includes('CAPABILITY_UNAVAILABLE')) setUnavailable(true)
				else setError(message)
			})
	}, [client])

	// Every write is optimistic: the preview is the answer, and the file is the same bytes
	// this pane already holds — a re-read would only tell it what it just said.
	const run = (next: Wallpaper, write: () => Promise<unknown>) => {
		setWallpaper(next)
		setError(null)
		write().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
	}

	const setColor = (hex: string) =>
		run({ color: hex, image: null }, () => client.setWallpaperColor({ color: hex }))

	const setImage = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0]
		// Let the same file be picked twice in a row (the input keeps its value otherwise).
		event.target.value = ''
		if (!file) return
		const bytes = new Uint8Array(await file.arrayBuffer())
		const image = imageDataUrl(bytes)
		if (!image) return setError(`${file.name} isn’t an image this device can read.`)
		run({ color: null, image }, () => client.setWallpaperImage({ bytes }))
	}

	if (unavailable) {
		return (
			<div className="settings-pane">
				<Header />
				<section className="settings-card">
					<p className="settings-muted">This device’s desktop has no wallpaper to change.</p>
				</section>
			</div>
		)
	}

	return (
		<div className="settings-pane">
			<Header />
			<section className="settings-card">
				<h2 className="settings-card-title">Wallpaper</h2>
				<div className="wp">
					<Preview wallpaper={wallpaper} />
					<div className="wp-tray">
						<div className="wp-chips">
							{WALLPAPER_COLORS.map((preset) => (
								<button
									key={preset.hex}
									type="button"
									className="wp-tile"
									style={{ background: preset.hex }}
									data-light={isLight(preset.hex) || undefined}
									aria-pressed={wallpaper.color === preset.hex}
									aria-label={preset.name}
									title={`${preset.name} · ${preset.hex.toUpperCase()}`}
									onClick={() => setColor(preset.hex)}
								>
									<span className="wp-check" aria-hidden>
										✓
									</span>
								</button>
							))}
						</div>
						<span className="wp-sep" />
						<CustomColor wallpaper={wallpaper} onPick={setColor} />
						<label
							className="wp-tile wp-pick"
							data-has={Boolean(wallpaper.image) || undefined}
							data-on={Boolean(wallpaper.image) || undefined}
							style={wallpaper.image ? { backgroundImage: `url(${wallpaper.image})` } : undefined}
							title="Use your own picture"
						>
							{wallpaper.image ? '' : '＋'}
							<input type="file" accept="image/*" onChange={(e) => void setImage(e)} />
						</label>
					</div>
					<div className="wp-foot">
						<span className="wp-caption">{caption(wallpaper)}</span>
						<button
							type="button"
							className="settings-small-button"
							disabled={!wallpaper.color && !wallpaper.image}
							onClick={() => run(NONE, () => client.clearWallpaper({}))}
						>
							Reset
						</button>
					</div>
				</div>
				{error ? <p className="settings-card-error">{error}</p> : null}
				<p className="settings-card-copy">
					Saved to your volume, so your desktop follows you to every device you sign in to.
				</p>
			</section>
		</div>
	)
}

function Header() {
	return (
		<header className="settings-pane-header">
			<h1 className="settings-pane-title">Appearance</h1>
			<p className="settings-pane-copy">How your desktop looks. Changes apply right away.</p>
		</header>
	)
}

// Any colour at all. The native well previews as you drag (`input`) but only WRITES when
// you commit (`change`) — a drag fires input continuously, and each one would be a write
// to the volume that syncs.
function CustomColor({
	wallpaper,
	onPick
}: {
	wallpaper: Wallpaper
	onPick: (hex: string) => void
}) {
	const custom = wallpaper.color && !WALLPAPER_COLORS.some((c) => c.hex === wallpaper.color)
	const [dragging, setDragging] = useState<string | null>(null)
	return (
		<span className="wp-well" data-on={custom || undefined} title="Any colour">
			<input
				type="color"
				aria-label="Custom wallpaper colour"
				value={dragging ?? wallpaper.color ?? '#46534a'}
				onInput={(e) => setDragging(e.currentTarget.value)}
				onChange={(e) => {
					const hex = normalizeHex(e.currentTarget.value)
					setDragging(null)
					if (hex) onPick(hex)
				}}
			/>
		</span>
	)
}

// The simulation. Two ghost windows and a pill, because a wallpaper is judged with
// something sitting on top of it.
function Preview({ wallpaper }: { wallpaper: Wallpaper }) {
	const background = wallpaper.image
		? { backgroundImage: `url(${wallpaper.image})` }
		: wallpaper.color
			? { background: wallpaper.color }
			: undefined
	return (
		<div className="wp-mini">
			<div className="wp-field" style={background} />
			<div className="wp-bar">
				<span className="wp-bar-group">
					<span className="wp-bar-title">Notes</span>
					<span className="wp-quiet">1.2.0</span>
				</span>
				<span className="wp-bar-group">
					<span className="wp-quiet">Synced</span>
					<span className="wp-dot" />
					<span className="wp-quiet">Wed 9:41</span>
					<span className="wp-avatar" />
				</span>
			</div>
			{[0, 1].map((i) => (
				<div key={i} className="wp-win" data-i={i}>
					<div className="wp-win-bar">
						<i />
						<i />
					</div>
					<div className="wp-win-body">
						<b />
						<b />
						<b />
						<b />
					</div>
				</div>
			))}
			<div className="wp-omni">
				<span className="wp-omni-face" />
				<span className="wp-omni-ph">Ask, or open an app…</span>
				<span className="wp-omni-key">⌘K</span>
			</div>
		</div>
	)
}
