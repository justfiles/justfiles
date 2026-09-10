import { imageDataUrl } from '@justfiles/app/image-type'
import { type ChangeEvent, type CSSProperties, useEffect, useRef, useState } from 'react'
import { DOCK_MATERIALS, normalizeHex, type SettingsActions, WALLPAPER_COLORS } from './model.ts'
import type { DockMaterial } from './types.ts'
import './appearance-pane.css'
type Wallpaper = { color: string | null; image: string | null }

const NONE: Wallpaper = { color: null, image: null }
function caption(wallpaper: Wallpaper): string {
	if (wallpaper.image) return 'Your picture'
	if (!wallpaper.color) return 'Default'
	const preset = WALLPAPER_COLORS.find((c) => c.hex === wallpaper.color)
	return `${preset?.name ?? 'Custom'} · ${wallpaper.color.toUpperCase()}`
}
function isLight(hex: string): boolean {
	const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
	return 0.299 * (r ?? 0) + 0.587 * (g ?? 0) + 0.114 * (b ?? 0) > 150
}

export function AppearancePane({ client }: { client: SettingsActions }) {
	const [wallpaper, setWallpaper] = useState<Wallpaper>(NONE)
	const [material, setMaterial] = useState<DockMaterial>('smoked')
	const [previewMaterial, setPreviewMaterial] = useState<DockMaterial | null>(null)
	const [unavailable, setUnavailable] = useState(false)
	const [dockUnavailable, setDockUnavailable] = useState(false)
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
				if (message.includes('SETTINGS_UNAVAILABLE')) setUnavailable(true)
				else setError(message)
			})
		client
			.readDockMaterial({})
			.then(setMaterial)
			.catch((e: unknown) => {
				const message = e instanceof Error ? e.message : String(e)
				if (message.includes('SETTINGS_UNAVAILABLE')) setDockUnavailable(true)
				else setError(message)
			})
	}, [client])
	const queue = useRef<Promise<unknown>>(Promise.resolve())
	const seq = useRef(0)
	const enqueue = (write: () => Promise<unknown>) => {
		const done = queue.current.then(write, write)
		queue.current = done.catch(() => {})
		done.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
	}
	const run = (next: Wallpaper | Promise<Wallpaper>, write: () => Promise<unknown>) => {
		setError(null)
		const claim = ++seq.current
		void Promise.resolve(next).then(
			(wallpaper) => {
				if (claim === seq.current) setWallpaper(wallpaper)
			},
			() => {}
		)
		enqueue(write)
	}

	const setColor = (hex: string) =>
		run({ color: hex, image: null }, () => client.setWallpaperColor({ color: hex }))
	const pickMaterial = (next: DockMaterial) => {
		setError(null)
		setMaterial(next)
		setPreviewMaterial(null)
		enqueue(() => client.setDockMaterial({ material: next }))
	}
	const setImage = (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0]
		event.target.value = ''
		if (!file) return
		const read = file.arrayBuffer().then((buffer) => {
			const bytes = new Uint8Array(buffer)
			const image = imageDataUrl(bytes)
			if (!image) throw new Error(`${file.name} isn’t an image this device can read.`)
			return { bytes, image }
		})
		run(
			read.then(({ image }) => ({ color: null, image })),
			async () => client.setWallpaperImage({ bytes: (await read).bytes })
		)
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
			<Preview wallpaper={wallpaper} material={previewMaterial ?? material} />
			<p className="wp-hint">Click the dock to see it open.</p>
			<section className="settings-card">
				<h2 className="settings-card-title">Wallpaper</h2>
				<div className="wp">
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
						<CustomColor
							wallpaper={wallpaper}
							onPick={setColor}
							onDrag={(hex) => setWallpaper({ color: hex, image: null })}
						/>
						<label
							className="wp-tile wp-pick"
							data-has={Boolean(wallpaper.image) || undefined}
							data-on={Boolean(wallpaper.image) || undefined}
							style={wallpaper.image ? { backgroundImage: `url(${wallpaper.image})` } : undefined}
							title="Use your own picture"
						>
							{wallpaper.image ? '' : '＋'}
							<input type="file" accept="image/*" onChange={setImage} />
						</label>
					</div>
					<div className="wp-foot">
						<span className="wp-caption">{caption(wallpaper)}</span>
						<button
							type="button"
							data-size="sm"
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
			{dockUnavailable ? null : (
				<section className="settings-card">
					<h2 className="settings-card-title">Dock</h2>
					<div className="mat-row">
						{DOCK_MATERIALS.map((item) => (
							<button
								key={item.name}
								type="button"
								className="mat-tile"
								aria-pressed={material === item.name}
								onPointerEnter={() => setPreviewMaterial(item.name)}
								onPointerLeave={() => setPreviewMaterial(null)}
								onFocus={() => setPreviewMaterial(item.name)}
								onBlur={() => setPreviewMaterial(null)}
								onClick={() => pickMaterial(item.name)}
							>
								<span
									className="mat-sample"
									data-material={item.name}
									style={wallpaperStyle(wallpaper)}
								>
									<span className="mat-bar ds-slot">
										<span className="mat-field" />
										<span className="mat-key">N</span>
									</span>
								</span>
								<span className="mat-label">{item.label}</span>
							</button>
						))}
					</div>
					<p className="mat-caption">
						{DOCK_MATERIALS.find((item) => item.name === (previewMaterial ?? material))?.caption}
					</p>
				</section>
			)}
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
function CustomColor({
	wallpaper,
	onPick,
	onDrag
}: {
	wallpaper: Wallpaper
	onPick: (hex: string) => void
	onDrag: (hex: string) => void
}) {
	const custom = wallpaper.color && !WALLPAPER_COLORS.some((c) => c.hex === wallpaper.color)
	const input = useRef<HTMLInputElement>(null)
	const pick = useRef(onPick)
	pick.current = onPick
	useEffect(() => {
		const el = input.current
		if (!el) return
		const commit = () => {
			const hex = normalizeHex(el.value)
			if (hex) pick.current(hex)
		}
		el.addEventListener('change', commit)
		return () => el.removeEventListener('change', commit)
	}, [])
	return (
		<span className="wp-well" data-on={custom || undefined} title="Any colour">
			<input
				ref={input}
				type="color"
				aria-label="Custom wallpaper colour"
				value={wallpaper.color ?? '#46534a'}
				onChange={(e) => onDrag(e.currentTarget.value)}
			/>
		</span>
	)
}

function wallpaperStyle(wallpaper: Wallpaper) {
	return wallpaper.image
		? { backgroundImage: `url(${wallpaper.image})` }
		: wallpaper.color
			? { background: wallpaper.color }
			: undefined
}

function Preview({ wallpaper, material }: { wallpaper: Wallpaper; material: DockMaterial }) {
	const [open, setOpen] = useState(false)
	return (
		<div className="wp-mini" data-material={material} data-open={open}>
			<div className="wp-field" style={wallpaperStyle(wallpaper)} />
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
			<div className="wp-windows">
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
			</div>
			<button
				type="button"
				className="wp-dock"
				data-open={open}
				aria-label="Preview the dock open"
				onClick={() => setOpen((value) => !value)}
			>
				<div className="wp-dock-sheet ds-raised">
					<div className="wp-dock-sheet-label">On this computer</div>
					<div className="wp-dock-grid">
						{['#e0a13c', '#d9605c', '#4f8fd6', '#7a6bd8', '#3fa08a'].map((color) => (
							<span key={color} style={{ '--key': color } as CSSProperties} />
						))}
					</div>
				</div>
				<div className="wp-dock-bar ds-slot">
					<div className="wp-dock-field">Search apps, or talk to Computer…</div>
					<div className="wp-dock-apps">
						{[
							['N', '#e0a13c'],
							['P', '#d9605c'],
							['F', '#4f8fd6']
						].map(([label, color]) => (
							<span key={label} className="wp-dock-key" style={{ '--key': color } as CSSProperties}>
								{label}
							</span>
						))}
						<span className="wp-dock-face" />
					</div>
				</div>
			</button>
		</div>
	)
}
