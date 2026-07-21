import { injectStyle } from '@justfiles/app/browser'
import type { GUIProps } from '@justfiles/app/react'
import { useEffect, useRef, useState } from 'react'
import type { app } from './app.ts'
import { charToIndex, type PixelDoc, TRANSPARENT } from './doc.ts'

// Layout only — chrome colours read platform tokens (`--surface`, `--rule`,
// `--text`, `--window-bg`) so the app matches native chrome and gets dark mode
// for free. The transparency checker uses neutral greys on purpose: like every
// pixel editor it is a document indicator, not a theme surface.
injectStyle(
	`
.pixel { display: flex; flex-direction: column; height: 100%; width: 100%; background: var(--window-bg); color: var(--text); }
.pixel-bar { display: flex; flex: none; align-items: center; gap: 8px; padding: 6px 10px; background: var(--surface); border-bottom: 1px solid var(--rule); font-size: 12px; }
.pixel-title { font-weight: 600; }
.pixel-bar button { padding: 1px 8px; font-size: 12px; }
.pixel-zoom { min-width: 3.5em; text-align: center; font-variant-numeric: tabular-nums; }
.pixel-spacer { flex: 1; }
.pixel-dim { opacity: 0.6; }
.pixel-mat { flex: 1; min-height: 0; min-width: 0; overflow: auto; display: grid; place-items: center; padding: 24px; background: color-mix(in srgb, var(--text) 12%, var(--window-bg)); }
.pixel-canvas { display: block; image-rendering: pixelated; box-shadow: 0 1px 8px rgba(0, 0, 0, 0.35); }
.pixel-palette { display: flex; flex: none; flex-wrap: wrap; gap: 4px; padding: 8px 12px; background: var(--surface); border-top: 1px solid var(--rule); }
.pixel-swatch { width: 18px; height: 18px; border: 1px solid var(--rule); border-radius: 3px; }
`,
	'app-pixel'
)

const CHECKER_A = '#bfbfbf'
const CHECKER_B = '#8f8f8f'
const GRID_LINE = 'rgba(128, 128, 128, 0.4)'

// Pure render of grid + palette onto a pixelated canvas at integer zoom, on a
// checkerboard mat (index 0 = transparent), with an optional grid-line overlay.
function paint(canvas: HTMLCanvasElement, doc: PixelDoc, zoom: number, showGrid: boolean): void {
	const { width, height, palette, grid } = doc
	const w = width * zoom
	const h = height * zoom
	canvas.width = w
	canvas.height = h
	const ctx = canvas.getContext('2d')
	if (!ctx) return
	ctx.imageSmoothingEnabled = false

	// Checkerboard behind everything; opaque pixels paint over it, so transparent
	// cells show through. Tile is half a pixel-cell (≥ 4px) for a clear check.
	const tile = Math.max(4, Math.floor(zoom / 2))
	for (let y = 0; y < h; y += tile) {
		for (let x = 0; x < w; x += tile) {
			ctx.fillStyle =
				(Math.floor(x / tile) + Math.floor(y / tile)) % 2 === 0 ? CHECKER_A : CHECKER_B
			ctx.fillRect(x, y, tile, tile)
		}
	}

	for (let y = 0; y < height; y++) {
		const row = grid[y] ?? ''
		for (let x = 0; x < width; x++) {
			const ch = row[x] ?? TRANSPARENT
			if (ch === TRANSPARENT) continue
			const color = palette[charToIndex(ch) - 1]
			if (!color) continue
			ctx.fillStyle = color
			ctx.fillRect(x * zoom, y * zoom, zoom, zoom)
		}
	}

	if (showGrid && zoom >= 4) {
		ctx.fillStyle = GRID_LINE
		for (let x = 0; x <= width; x++) ctx.fillRect(x * zoom, 0, 1, h)
		for (let y = 0; y <= height; y++) ctx.fillRect(0, y * zoom, w, 1)
	}
}

const fitZoom = (doc: PixelDoc) => Math.max(1, Math.floor(512 / Math.max(doc.width, doc.height)))

export default function Pixel({ state }: GUIProps<typeof app>) {
	const { doc } = state
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const [zoom, setZoom] = useState(() => fitZoom(doc))
	const [showGrid, setShowGrid] = useState(true)

	useEffect(() => {
		if (canvasRef.current) paint(canvasRef.current, doc, zoom, showGrid)
	}, [doc, zoom, showGrid])

	return (
		<div className="pixel">
			<header className="pixel-bar">
				<span className="pixel-title">Pixel</span>
				<button type="button" onClick={() => setZoom((z) => Math.max(1, z - 1))}>
					−
				</button>
				<span className="pixel-zoom">{zoom}×</span>
				<button type="button" onClick={() => setZoom((z) => Math.min(32, z + 1))}>
					+
				</button>
				<button type="button" aria-pressed={showGrid} onClick={() => setShowGrid((g) => !g)}>
					Grid {showGrid ? 'on' : 'off'}
				</button>
				<span className="pixel-spacer" />
				<span className="pixel-dim">
					{doc.width}×{doc.height}
				</span>
			</header>
			<div className="pixel-mat">
				<canvas ref={canvasRef} className="pixel-canvas" />
			</div>
			<footer className="pixel-palette">
				{doc.palette.map((color, i) => (
					<div
						key={color}
						className="pixel-swatch"
						title={`${i + 1}: ${color}`}
						style={{ background: color }}
					/>
				))}
			</footer>
		</div>
	)
}
