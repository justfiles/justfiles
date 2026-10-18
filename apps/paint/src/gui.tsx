import type { Client } from '@justfiles/app'
import { defineGUI, injectStyle } from '@justfiles/app/browser'
import { StrictMode, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { initialState, type PaintApp, type PaintState, type Size, type Tool } from './app.ts'
import { canvasToPngBase64, restore, snapshot, stampLine, stampPoint } from './bitmap.ts'
import { BACKGROUND, CANVAS_H, CANVAS_W, drawOp, newDoc, newId, type Op, replay } from './doc.ts'
import type { Store } from './state.ts'
import {
	createPaintStore,
	makePersistEffect,
	type PaintAction,
	type PaintStoreState,
	type PersistController
} from './store.ts'

// Layout only — every colour reads a platform token (`--surface`, `--rule`,
// `--focus`, `--window-bg`), so the app matches the native chrome and gets dark
// mode for free. The previous version leaned on Tailwind utility classes + a few
// hardcoded greys; Tailwind isn't served outside the standalone dev server, so in
// the OS shell those classes were dead and the layout collapsed. `--paint-paper`
// is the white drawing sheet (the exported PNG background, a document fact, not a
// theme colour); `--paint-mat` is the shaded workspace behind it.
injectStyle(
	`
.paint { display: flex; flex-direction: column; height: 100%; width: 100%; background: var(--window-bg); color: var(--text); --paint-paper: #ffffff; --paint-mat: color-mix(in srgb, var(--text) 12%, var(--window-bg)); }

.paint-bar { display: flex; flex: none; align-items: center; gap: 6px; padding: 6px 10px; background: var(--surface); border-bottom: 1px solid var(--rule); }
.paint-btn { flex: none; padding: 1px 10px; font-size: 12px; }
.paint-status { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; opacity: 0.6; }
.paint-status[data-error="true"] { color: var(--danger); opacity: 1; }

.paint-body { display: flex; flex: 1; min-height: 0; }

.paint-tools { display: flex; flex: none; flex-direction: column; align-items: center; gap: 8px; width: 72px; padding: 10px 0; background: var(--surface); border-right: 1px solid var(--rule); }
.paint-tool-group { display: flex; flex-direction: column; gap: 4px; }
.paint-tool { width: 56px; padding: 4px 0; font-size: 11px; text-align: center; }
.paint-tool[data-active="true"] { background: var(--focus); color: var(--on-focus); border-color: var(--focus); }
.paint-sep { height: 1px; width: 60%; background: var(--rule); margin: 2px 0; }
.paint-sizes { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.paint-size { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 22px; padding: 0; }
.paint-size[data-active="true"] { background: var(--focus); border-color: var(--focus); }
.paint-size-dot { border-radius: 50%; background: var(--text); }
.paint-size[data-active="true"] .paint-size-dot { background: var(--on-focus); }

.paint-mat { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 16px; background: var(--paint-mat); }
.paint-canvas { display: block; background: var(--paint-paper); box-shadow: 0 1px 6px rgba(0, 0, 0, 0.25); image-rendering: pixelated; touch-action: none; cursor: crosshair; }

.paint-colors { display: flex; flex: none; align-items: center; gap: 10px; padding: 8px 12px; background: var(--surface); border-top: 1px solid var(--rule); }
.paint-current { flex: none; width: 28px; height: 28px; border: 1px solid var(--rule); border-radius: 4px; }
.paint-swatches { display: flex; gap: 4px; }
.paint-swatch { width: 18px; height: 18px; padding: 0; border: 1px solid var(--rule); border-radius: 3px; }
.paint-swatch[data-active="true"] { border: 2px solid var(--focus); }
.paint-custom { margin-left: 4px; display: flex; align-items: center; gap: 6px; font-size: 11px; opacity: 0.75; }
.paint-custom input { width: 24px; height: 24px; padding: 0; border: none; background: transparent; }
`,
	'app-paint'
)

const TOOLS: { id: Tool; label: string }[] = [
	{ id: 'pencil', label: 'Pencil' },
	{ id: 'eraser', label: 'Eraser' },
	{ id: 'fill', label: 'Fill' },
	{ id: 'line', label: 'Line' },
	{ id: 'rect', label: 'Rect' },
	{ id: 'ellipse', label: 'Ellipse' }
]

const SIZES: Size[] = [1, 3, 5]

const PALETTE = [
	'#000000',
	'#ffffff',
	'#e64545',
	'#f5b400',
	'#3aa84a',
	'#3b78e6',
	'#7e3bd4',
	'#8c5a2c'
]

const stateOrInitial = (value: unknown): PaintState =>
	value && typeof value === 'object' && 'tool' in value ? (value as PaintState) : initialState

export const gui = defineGUI<PaintApp>({
	mount(el, state, ctx) {
		const root = createRoot(el)
		const render = (next: PaintState | null) =>
			root.render(
				<StrictMode>
					<Paint state={stateOrInitial(next)} client={ctx.client} />
				</StrictMode>
			)
		render(state)
		return {
			update: render,
			unmount() {
				root.unmount()
			}
		}
	}
})

// An in-progress op being dragged out; committed to the doc on pointer-up.
// `base` is the committed canvas for shape preview (restored each move).
interface Drag {
	op: Op
	base: ImageData | null
}

function Paint({ state, client }: { state: PaintState; client: Client<PaintApp> }) {
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const dragRef = useRef<Drag | null>(null)
	const clientRef = useRef(client)
	clientRef.current = client
	const docIdRef = useRef<string | null>(state.currentDocId)

	// The store (committed op-log) and its debounced autosave are created once
	// per mount. Persist writes the doc to the app data volume via the typed
	// client — a query, so the drawing never touches kernel /state.
	const setup = useRef<{
		store: Store<PaintStoreState, PaintAction>
		persist: PersistController
	} | null>(null)
	if (!setup.current) {
		const persist = makePersistEffect((doc) => {
			const docId = docIdRef.current
			if (docId) void clientRef.current.saveDraft({ docId, doc })
		})
		setup.current = { store: createPaintStore(persist), persist }
	}
	const { store } = setup.current

	const [busy, setBusy] = useState(false)
	// React 19's native store subscription — avoids the use-sync-external-store
	// CJS shim, whose `require('react')` breaks the react-external app bundle.
	const canUndo = useSyncExternalStore(store.subscribe, () => store.getState().doc.ops.length > 0)
	const canRedo = useSyncExternalStore(store.subscribe, () => store.getState().redo.length > 0)

	const { tool, size, color, lastSavedPath, lastError } = state

	const getCtx = () => canvasRef.current?.getContext('2d', { willReadFrequently: true }) ?? null

	// The canvas is a pure replay of the store's doc; redraw on every change
	// (commit / undo / redo / hydrate). Live drawing paints imperatively between
	// commits; the commit's replay then redraws the identical pixels.
	useEffect(() => {
		const ctx = canvasRef.current?.getContext('2d', { willReadFrequently: true })
		if (!ctx) return
		ctx.imageSmoothingEnabled = false
		const render = () => replay(ctx, store.getState().doc)
		render()
		return store.subscribe(render)
	}, [store])

	// Resolve the draft id through a handler (its result is the authoritative
	// persisted state, so this doesn't race the async state push that arrives on
	// reload), then hydrate the store from the autosaved draft.
	useEffect(() => {
		let cancelled = false
		void (async () => {
			const next = await clientRef.current.ensureDoc({ candidate: newId() })
			const docId = next.currentDocId
			if (cancelled || !docId) return
			docIdRef.current = docId
			const loaded = await clientRef.current.loadDraft({ docId })
			if (!cancelled) store.dispatch({ type: 'loaded', doc: loaded ?? newDoc() })
		})()
		return () => {
			cancelled = true
		}
	}, [store])

	// Flush any pending autosave on unmount / page hide.
	useEffect(() => {
		const onHide = () => setup.current?.persist.flush()
		window.addEventListener('pagehide', onHide)
		return () => {
			window.removeEventListener('pagehide', onHide)
			onHide()
		}
	}, [])

	const pos = (e: { clientX: number; clientY: number }) => {
		const canvas = canvasRef.current
		if (!canvas) return { x: 0, y: 0 }
		const rect = canvas.getBoundingClientRect()
		const sx = canvas.width / rect.width
		const sy = canvas.height / rect.height
		return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy }
	}

	const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const canvas = canvasRef.current
		const ctx = getCtx()
		if (!canvas || !ctx) return
		canvas.setPointerCapture(e.pointerId)
		const p = pos(e)
		const x = Math.round(p.x)
		const y = Math.round(p.y)

		// Fill is order-dependent on prior pixels — let the commit's replay run it.
		if (tool === 'fill') {
			store.dispatch({ type: 'commit', op: { id: newId(), kind: 'fill', color, x, y } })
			return
		}
		if (tool === 'pencil' || tool === 'eraser') {
			const strokeColor = tool === 'eraser' ? BACKGROUND : color
			stampPoint(ctx, x, y, size, strokeColor)
			dragRef.current = {
				op: { id: newId(), kind: 'stroke', tool, size, color: strokeColor, points: [x, y] },
				base: null
			}
			return
		}
		// line | rect | ellipse — preview restores from the committed canvas.
		dragRef.current = {
			op: { id: newId(), kind: tool, size, color, x0: x, y0: y, x1: x, y1: y } as Op,
			base: snapshot(ctx)
		}
	}

	const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const drag = dragRef.current
		const ctx = getCtx()
		if (!drag || !ctx) return
		const op = drag.op

		if (op.kind === 'stroke') {
			const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? []
			const points = coalesced.length > 0 ? coalesced : [e.nativeEvent]
			for (const ev of points) {
				const p = pos(ev)
				const px = op.points[op.points.length - 2] ?? 0
				const py = op.points[op.points.length - 1] ?? 0
				const nx = Math.round(p.x)
				const ny = Math.round(p.y)
				stampLine(ctx, px, py, nx, ny, op.size, op.color)
				op.points.push(nx, ny)
			}
			return
		}
		if (op.kind === 'line' || op.kind === 'rect' || op.kind === 'ellipse') {
			const p = pos(e)
			if (drag.base) restore(ctx, drag.base)
			op.x1 = Math.round(p.x)
			op.y1 = Math.round(p.y)
			drawOp(ctx, op)
		}
	}

	const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const canvas = canvasRef.current
		if (canvas?.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
		const drag = dragRef.current
		dragRef.current = null
		if (drag) store.dispatch({ type: 'commit', op: drag.op })
	}

	const handleUndo = () => store.dispatch({ type: 'undo' })
	const handleRedo = () => store.dispatch({ type: 'redo' })
	const handleNew = () =>
		store.dispatch({ type: 'commit', op: { id: newId(), kind: 'clear', color: BACKGROUND } })

	const handleSave = async () => {
		const canvas = canvasRef.current
		if (!canvas || busy) return
		setBusy(true)
		try {
			const pngBase64 = await canvasToPngBase64(canvas)
			await client.save({ pngBase64 })
		} finally {
			setBusy(false)
		}
	}

	const status = lastError ?? (lastSavedPath ? `Saved ${lastSavedPath}` : '')

	return (
		<div className="paint">
			<header className="paint-bar">
				<button type="button" className="paint-btn" onClick={handleNew}>
					New
				</button>
				<button type="button" className="paint-btn" onClick={handleSave} disabled={busy}>
					Save
				</button>
				<button type="button" className="paint-btn" onClick={handleUndo} disabled={!canUndo}>
					Undo
				</button>
				<button type="button" className="paint-btn" onClick={handleRedo} disabled={!canRedo}>
					Redo
				</button>
				<span className="paint-status" data-error={Boolean(lastError)}>
					{busy ? 'Saving…' : status}
				</span>
			</header>

			<div className="paint-body">
				<Toolbar
					tool={tool}
					size={size}
					onTool={(t) => void client.setTool({ tool: t })}
					onSize={(s) => void client.setSize({ size: s })}
				/>
				<div className="paint-mat">
					<canvas
						ref={canvasRef}
						width={CANVAS_W}
						height={CANVAS_H}
						onPointerDown={handlePointerDown}
						onPointerMove={handlePointerMove}
						onPointerUp={handlePointerUp}
						onPointerCancel={handlePointerUp}
						className="paint-canvas"
					/>
				</div>
			</div>

			<ColorStrip color={color} onColor={(c) => void client.setColor({ color: c })} />
		</div>
	)
}

function Toolbar(props: {
	tool: Tool
	size: Size
	onTool: (t: Tool) => void
	onSize: (s: Size) => void
}) {
	return (
		<aside className="paint-tools">
			<div className="paint-tool-group">
				{TOOLS.map(({ id, label }) => (
					<button
						key={id}
						type="button"
						className="paint-tool"
						title={label}
						aria-pressed={props.tool === id}
						data-active={props.tool === id}
						onClick={() => props.onTool(id)}
					>
						{label}
					</button>
				))}
			</div>
			<div className="paint-sep" aria-hidden />
			<div className="paint-sizes">
				{SIZES.map((value) => (
					<button
						key={value}
						type="button"
						className="paint-size"
						title={`Size ${value}`}
						aria-pressed={props.size === value}
						data-active={props.size === value}
						onClick={() => props.onSize(value)}
					>
						<span
							className="paint-size-dot"
							style={{ width: value * 2 + 2, height: value * 2 + 2 }}
						/>
					</button>
				))}
			</div>
		</aside>
	)
}

function ColorStrip(props: { color: string; onColor: (c: string) => void }) {
	return (
		<footer className="paint-colors">
			<div
				className="paint-current"
				title={`Current color ${props.color}`}
				style={{ background: props.color }}
			/>
			<div className="paint-swatches">
				{PALETTE.map((c) => (
					<button
						key={c}
						type="button"
						className="paint-swatch"
						title={c}
						aria-pressed={props.color.toLowerCase() === c}
						data-active={props.color.toLowerCase() === c}
						onClick={() => props.onColor(c)}
						style={{ background: c }}
					/>
				))}
			</div>
			<label className="paint-custom">
				<span>Custom</span>
				<input type="color" value={props.color} onChange={(e) => props.onColor(e.target.value)} />
			</label>
		</footer>
	)
}
