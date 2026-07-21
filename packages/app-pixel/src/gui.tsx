import { injectStyle } from '@justfiles/app/browser'
import type { GUIProps } from '@justfiles/app/react'
import { useEffect, useReducer, useRef, useState } from 'react'
import type { app, Tool } from './app.ts'
import { drawLine, drawRect, setPixels } from './bitmap.ts'
import { charToIndex, getPixel, MAX_COLORS, type PixelDoc, SIZES, TRANSPARENT } from './doc.ts'

// Layout only — chrome colours read platform tokens (`--surface`, `--rule`,
// `--text`, `--window-bg`, `--focus`) so the app matches native chrome and gets
// dark mode for free. The transparency checker uses neutral greys on purpose:
// like every pixel editor it is a document indicator, not a theme surface.
injectStyle(
	`
.pixel { display: flex; flex-direction: column; height: 100%; width: 100%; background: var(--window-bg); color: var(--text); }
.pixel-bar { display: flex; flex: none; align-items: center; gap: 8px; padding: 6px 10px; background: var(--surface); border-bottom: 1px solid var(--rule); font-size: 12px; }
.pixel-title { font-weight: 600; }
.pixel-bar button, .pixel-bar select { padding: 1px 8px; font-size: 12px; }
.pixel-zoom { min-width: 3.5em; text-align: center; font-variant-numeric: tabular-nums; }
.pixel-spacer { flex: 1; }
.pixel-dim { opacity: 0.6; }
.pixel-body { display: flex; flex: 1; min-height: 0; }
.pixel-tools { display: flex; flex: none; flex-direction: column; gap: 4px; width: 76px; padding: 10px 8px; background: var(--surface); border-right: 1px solid var(--rule); }
.pixel-tool { padding: 5px 0; font-size: 12px; text-align: center; }
.pixel-tool[data-active="true"] { background: var(--focus); color: var(--on-focus); border-color: var(--focus); }
.pixel-mat { flex: 1; min-height: 0; min-width: 0; overflow: auto; display: grid; place-items: center; padding: 24px; background: color-mix(in srgb, var(--text) 12%, var(--window-bg)); }
.pixel-canvas { display: block; image-rendering: pixelated; box-shadow: 0 1px 8px rgba(0, 0, 0, 0.35); touch-action: none; cursor: crosshair; }
.pixel-palette { display: flex; flex: none; align-items: center; flex-wrap: wrap; gap: 6px; padding: 8px 12px; background: var(--surface); border-top: 1px solid var(--rule); font-size: 12px; }
.pixel-swatches { display: flex; flex-wrap: wrap; gap: 4px; }
.pixel-swatch { width: 18px; height: 18px; padding: 0; border: 1px solid var(--rule); border-radius: 3px; background-size: 8px 8px; }
.pixel-swatch[data-active="true"] { border: 2px solid var(--focus); }
.pixel-active { min-width: 4.5em; opacity: 0.7; font-variant-numeric: tabular-nums; }
.pixel-edit { width: 26px; height: 26px; padding: 0; border: 1px solid var(--rule); background: transparent; }
`,
	'app-pixel'
)

const CHECKER_A = '#bfbfbf'
const CHECKER_B = '#8f8f8f'
const GRID_LINE = 'rgba(128, 128, 128, 0.4)'
// A tiny CSS checkerboard for the transparent (index 0) swatch.
const TRANSPARENT_SWATCH = `repeating-conic-gradient(${CHECKER_A} 0% 25%, ${CHECKER_B} 0% 50%) 0 0 / 8px 8px`

const TOOLS: { id: Tool; label: string }[] = [
	{ id: 'pencil', label: 'Pencil' },
	{ id: 'eraser', label: 'Eraser' },
	{ id: 'fill', label: 'Fill' },
	{ id: 'eyedropper', label: 'Pick' },
	{ id: 'line', label: 'Line' },
	{ id: 'rect', label: 'Rect' }
]

// Pure render of grid + palette onto a pixelated canvas at integer zoom, on a
// checkerboard mat (index 0 = transparent), with an optional grid-line overlay.
function paint(
	canvas: HTMLCanvasElement,
	doc: PixelDoc,
	grid: string[],
	zoom: number,
	showGrid: boolean
): void {
	const { width, height, palette } = doc
	const w = width * zoom
	const h = height * zoom
	canvas.width = w
	canvas.height = h
	const ctx = canvas.getContext('2d')
	if (!ctx) return
	ctx.imageSmoothingEnabled = false

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

type Pixel = { x: number; y: number; i: number }

// The cells that differ between two same-sized grids — the delta a committed
// stroke or an undo/redo restore replays through `setPixels`.
function diff(before: string[], after: string[]): Pixel[] {
	const out: Pixel[] = []
	for (let y = 0; y < after.length; y++) {
		const a = after[y] ?? ''
		const b = before[y] ?? ''
		for (let x = 0; x < a.length; x++) {
			const ch = a[x] ?? TRANSPARENT
			if (ch !== (b[x] ?? TRANSPARENT)) out.push({ x, y, i: charToIndex(ch) })
		}
	}
	return out
}

// An in-progress drag. A stroke accumulates onto a working grid (previewed live);
// a shape re-derives its preview from the committed grid each move.
type Drag =
	| { kind: 'stroke'; i: number; grid: string[]; x: number; y: number }
	| { kind: 'line' | 'rect'; x0: number; y0: number; x1: number; y1: number }

export default function Pixel({ state, actions }: GUIProps<typeof app>) {
	const { doc, tool, colorIndex } = state
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const dragRef = useRef<Drag | null>(null)
	const [zoom, setZoom] = useState(() => fitZoom(doc))
	const [showGrid, setShowGrid] = useState(true)
	const [, bump] = useReducer((n: number) => n + 1, 0)

	// GUI-local undo/redo: a snapshot per observed committed grid revision. Every
	// commit — human stroke or agent edit — lands here, so both share one timeline.
	// A restore replays a diff back through `setPixels`; `restoring` marks that
	// resulting revision so it isn't re-pushed. A resize (dimension change) can't
	// be diffed, so it rebases the timeline onto the new grid.
	const history = useRef<{ stack: string[][]; index: number }>({ stack: [doc.grid], index: 0 })
	const lastGrid = useRef(doc.grid)
	const dims = useRef({ w: doc.width, h: doc.height })
	const restoring = useRef(false)

	const render = (grid: string[]) => {
		if (canvasRef.current) paint(canvasRef.current, doc, grid, zoom, showGrid)
	}

	// The canvas is a pure function of the committed grid; repaint on any change
	// (stroke commit, agent edit, undo/redo, zoom, grid toggle).
	useEffect(() => {
		if (canvasRef.current) paint(canvasRef.current, doc, doc.grid, zoom, showGrid)
	}, [doc, zoom, showGrid])

	useEffect(() => {
		if (doc.grid === lastGrid.current) return
		if (doc.width !== dims.current.w || doc.height !== dims.current.h) {
			dims.current = { w: doc.width, h: doc.height }
			history.current = { stack: [doc.grid], index: 0 }
			restoring.current = false
		} else if (restoring.current) {
			restoring.current = false
		} else {
			const { stack, index } = history.current
			const next = stack.slice(0, index + 1)
			next.push(doc.grid)
			history.current = { stack: next, index: next.length - 1 }
		}
		lastGrid.current = doc.grid
		bump()
	}, [doc.grid, doc.width, doc.height])

	const toCell = (e: { clientX: number; clientY: number }) => {
		const canvas = canvasRef.current
		if (!canvas) return { x: 0, y: 0 }
		const rect = canvas.getBoundingClientRect()
		return {
			x: Math.floor(((e.clientX - rect.left) / rect.width) * doc.width),
			y: Math.floor(((e.clientY - rect.top) / rect.height) * doc.height)
		}
	}

	const shapePreview = (d: Extract<Drag, { kind: 'line' | 'rect' }>): string[] =>
		d.kind === 'line'
			? drawLine(doc.grid, d.x0, d.y0, d.x1, d.y1, colorIndex)
			: drawRect(doc.grid, ...rectArgs(d), colorIndex)

	const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const { x, y } = toCell(e)
		if (tool === 'eyedropper') {
			void actions.setColorIndex({ i: getPixel(doc.grid, x, y) })
			return
		}
		if (tool === 'fill') {
			void actions.floodFill({ x, y, i: colorIndex })
			return
		}
		canvasRef.current?.setPointerCapture(e.pointerId)
		if (tool === 'pencil' || tool === 'eraser') {
			const i = tool === 'eraser' ? 0 : colorIndex
			const grid = setPixels(doc.grid, [{ x, y, i }])
			dragRef.current = { kind: 'stroke', i, grid, x, y }
			render(grid)
			return
		}
		dragRef.current = { kind: tool, x0: x, y0: y, x1: x, y1: y }
	}

	const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const d = dragRef.current
		if (!d) return
		if (d.kind === 'stroke') {
			const events = e.nativeEvent.getCoalescedEvents?.() ?? []
			const pts = events.length > 0 ? events : [e.nativeEvent]
			for (const ev of pts) {
				const { x, y } = toCell(ev)
				d.grid = drawLine(d.grid, d.x, d.y, x, y, d.i)
				d.x = x
				d.y = y
			}
			render(d.grid)
			return
		}
		const { x, y } = toCell(e)
		d.x1 = x
		d.y1 = y
		render(shapePreview(d))
	}

	const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const canvas = canvasRef.current
		if (canvas?.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
		const d = dragRef.current
		dragRef.current = null
		if (!d) return
		if (d.kind === 'stroke') {
			const pixels = diff(doc.grid, d.grid)
			if (pixels.length > 0) void actions.setPixels({ pixels })
			else render(doc.grid)
		} else if (d.kind === 'line') {
			void actions.drawLine({ x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, i: colorIndex })
		} else {
			const [x, y, w, h] = rectArgs(d)
			void actions.drawRect({ x, y, w, h, i: colorIndex })
		}
	}

	const restore = (target: string[]) => {
		const pixels = diff(doc.grid, target)
		if (pixels.length === 0) return
		restoring.current = true
		void actions.setPixels({ pixels })
	}
	const undo = () => {
		const { stack, index } = history.current
		if (index <= 0) return
		history.current = { stack, index: index - 1 }
		restore(stack[index - 1] ?? doc.grid)
		bump()
	}
	const redo = () => {
		const { stack, index } = history.current
		if (index >= stack.length - 1) return
		history.current = { stack, index: index + 1 }
		restore(stack[index + 1] ?? doc.grid)
		bump()
	}

	const addColor = () => {
		const i = doc.palette.length + 1
		if (i > MAX_COLORS) return
		void actions.setPaletteColor({ i, color: '#000000' }).then(() => actions.setColorIndex({ i }))
	}
	const editColor = (color: string) => {
		if (colorIndex >= 1) void actions.setPaletteColor({ i: colorIndex, color })
	}
	const resizeTo = (size: number) => {
		if (size === doc.width && size === doc.height) return
		if (window.confirm(`Resize to ${size}×${size}? Pixels outside the new bounds are cropped.`))
			void actions.resize({ width: size, height: size })
	}

	const { index, stack } = history.current
	const activeColor = colorIndex >= 1 ? (doc.palette[colorIndex - 1] ?? '#000000') : '#000000'

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
				<button type="button" onClick={undo} disabled={index <= 0}>
					Undo
				</button>
				<button type="button" onClick={redo} disabled={index >= stack.length - 1}>
					Redo
				</button>
				<button type="button" onClick={() => void actions.clear({})}>
					Clear
				</button>
				<span className="pixel-spacer" />
				<select
					value={doc.width}
					onChange={(e) => resizeTo(Number(e.target.value))}
					aria-label="Canvas size"
				>
					{SIZES.map((s) => (
						<option key={s} value={s}>
							{s}×{s}
						</option>
					))}
				</select>
			</header>

			<div className="pixel-body">
				<aside className="pixel-tools">
					{TOOLS.map(({ id, label }) => (
						<button
							key={id}
							type="button"
							className="pixel-tool"
							aria-pressed={tool === id}
							data-active={tool === id}
							onClick={() => void actions.setTool({ tool: id })}
						>
							{label}
						</button>
					))}
				</aside>
				<div className="pixel-mat">
					<canvas
						ref={canvasRef}
						className="pixel-canvas"
						onPointerDown={onPointerDown}
						onPointerMove={onPointerMove}
						onPointerUp={onPointerUp}
						onPointerCancel={onPointerUp}
					/>
				</div>
			</div>

			<footer className="pixel-palette">
				<div className="pixel-swatches">
					<button
						type="button"
						className="pixel-swatch"
						title="Transparent (erase)"
						aria-pressed={colorIndex === 0}
						data-active={colorIndex === 0}
						onClick={() => void actions.setColorIndex({ i: 0 })}
						style={{ background: TRANSPARENT_SWATCH }}
					/>
					{doc.palette.map((color, k) => (
						<button
							key={color}
							type="button"
							className="pixel-swatch"
							title={`${k + 1}: ${color}`}
							aria-pressed={colorIndex === k + 1}
							data-active={colorIndex === k + 1}
							onClick={() => void actions.setColorIndex({ i: k + 1 })}
							style={{ background: color }}
						/>
					))}
					<button
						type="button"
						className="pixel-swatch"
						title="Add colour"
						onClick={addColor}
						disabled={doc.palette.length >= MAX_COLORS}
					>
						+
					</button>
				</div>
				<span className="pixel-active">{colorIndex === 0 ? 'transparent' : `#${colorIndex}`}</span>
				<input
					type="color"
					className="pixel-edit"
					title="Edit active colour"
					value={activeColor}
					disabled={colorIndex === 0}
					onChange={(e) => editColor(e.target.value)}
				/>
				<span className="pixel-spacer" />
				<span className="pixel-dim">
					{doc.width}×{doc.height}
				</span>
			</footer>
		</div>
	)
}

// Normalise a rect drag to top-left + positive extent for `drawRect`.
function rectArgs(d: {
	x0: number
	y0: number
	x1: number
	y1: number
}): [number, number, number, number] {
	return [
		Math.min(d.x0, d.x1),
		Math.min(d.y0, d.y1),
		Math.abs(d.x1 - d.x0) + 1,
		Math.abs(d.y1 - d.y0) + 1
	]
}
