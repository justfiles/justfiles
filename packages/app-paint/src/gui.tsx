import type { Client } from '@justfiles/app'
import { defineGUI } from '@justfiles/app/browser'
import type { Store } from '@justfiles/state'
import { StrictMode, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { initialState, type PaintApp, type PaintState, type Size, type Tool } from './app.ts'
import { canvasToPngBase64, restore, snapshot, stampLine, stampPoint } from './bitmap.ts'
import { BACKGROUND, CANVAS_H, CANVAS_W, drawOp, newDoc, newId, type Op, replay } from './doc.ts'
import {
	createPaintStore,
	makePersistEffect,
	type PaintAction,
	type PaintStoreState,
	type PersistController
} from './store.ts'

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
	menu: (state, client) => {
		const s = stateOrInitial(state)
		return [
			{
				title: 'Tools',
				items: TOOLS.map(({ id, label }) => ({
					title: label,
					checked: s.tool === id,
					onSelect: () => void client.setTool({ tool: id })
				}))
			},
			{
				title: 'Brush',
				items: SIZES.map((value) => ({
					title: `${value}px`,
					checked: s.size === value,
					onSelect: () => void client.setSize({ size: value })
				}))
			}
		]
	},
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
		<div
			className="flex h-full w-full flex-col"
			style={{
				background: '#ffffff',
				color: 'var(--text)',
				fontFamily: 'var(--font-ui)',
				fontSize: 'var(--text-ui)'
			}}
		>
			<header
				className="flex flex-none items-center gap-1 px-2 py-1"
				style={{ background: 'var(--surface)', borderBottom: '1px solid var(--rule)' }}
			>
				<MenuButton label="New" onClick={handleNew} />
				<MenuButton label="Save" onClick={handleSave} disabled={busy} />
				<MenuButton label="Undo" onClick={handleUndo} disabled={!canUndo} />
				<MenuButton label="Redo" onClick={handleRedo} disabled={!canRedo} />
				<span
					className="ml-auto truncate text-[11px]"
					style={{ color: lastError ? '#c93030' : 'var(--text)', opacity: lastError ? 1 : 0.6 }}
				>
					{busy ? 'Saving…' : status}
				</span>
			</header>

			<div className="flex min-h-0 flex-1">
				<Toolbar
					tool={tool}
					size={size}
					onTool={(t) => void client.setTool({ tool: t })}
					onSize={(s) => void client.setSize({ size: s })}
				/>
				<div className="min-h-0 flex-1 overflow-auto p-4" style={{ background: '#8a8a86' }}>
					<canvas
						ref={canvasRef}
						width={CANVAS_W}
						height={CANVAS_H}
						onPointerDown={handlePointerDown}
						onPointerMove={handlePointerMove}
						onPointerUp={handlePointerUp}
						onPointerCancel={handlePointerUp}
						className="block"
						style={{
							background: '#ffffff',
							boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
							imageRendering: 'pixelated',
							touchAction: 'none',
							cursor: 'crosshair'
						}}
					/>
				</div>
			</div>

			<ColorStrip color={color} onColor={(c) => void client.setColor({ color: c })} />
		</div>
	)
}

function MenuButton(props: { label: string; onClick: () => void; disabled?: boolean }) {
	return (
		<button
			type="button"
			onClick={props.onClick}
			disabled={props.disabled}
			className="inline-flex items-center gap-1 px-2 py-[3px]"
			style={{
				background: 'transparent',
				border: '1px solid transparent',
				borderRadius: 3,
				color: 'var(--text)',
				font: 'inherit',
				cursor: 'default',
				opacity: props.disabled ? 0.4 : 1
			}}
			onMouseEnter={(e) => {
				if (!props.disabled) e.currentTarget.style.background = 'rgba(0,0,0,0.06)'
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.background = 'transparent'
			}}
		>
			{props.label}
		</button>
	)
}

function Toolbar(props: {
	tool: Tool
	size: Size
	onTool: (t: Tool) => void
	onSize: (s: Size) => void
}) {
	return (
		<aside
			className="flex flex-none flex-col items-center gap-2 py-2"
			style={{
				width: 64,
				background: 'var(--surface)',
				borderRight: '1px solid var(--rule)'
			}}
		>
			<div className="grid grid-cols-1 gap-1">
				{TOOLS.map(({ id, label }) => {
					const active = props.tool === id
					return (
						<button
							key={id}
							type="button"
							title={label}
							aria-pressed={active}
							onClick={() => props.onTool(id)}
							className="inline-flex items-center justify-center px-2 py-1 text-[11px]"
							style={{
								width: 52,
								background: active ? 'var(--focus)' : '#ffffff',
								color: active ? 'var(--on-focus)' : 'var(--text)',
								border: '1px solid var(--rule)',
								borderRadius: 3,
								cursor: 'default'
							}}
						>
							{label}
						</button>
					)
				})}
			</div>
			<div
				style={{ height: 1, width: '70%', background: 'var(--rule)', margin: '4px 0' }}
				aria-hidden
			/>
			<div className="flex flex-col items-center gap-1">
				{SIZES.map((value) => {
					const active = props.size === value
					return (
						<button
							key={value}
							type="button"
							title={`Size ${value}`}
							aria-pressed={active}
							onClick={() => props.onSize(value)}
							className="inline-flex items-center justify-center"
							style={{
								width: 28,
								height: 18,
								background: active ? 'var(--focus)' : '#ffffff',
								border: '1px solid var(--rule)',
								borderRadius: 3,
								cursor: 'default'
							}}
						>
							<span
								style={{
									width: value * 2 + 2,
									height: value * 2 + 2,
									background: active ? 'var(--on-focus)' : 'var(--text)',
									borderRadius: '50%'
								}}
							/>
						</button>
					)
				})}
			</div>
		</aside>
	)
}

function ColorStrip(props: { color: string; onColor: (c: string) => void }) {
	return (
		<footer
			className="flex flex-none items-center gap-2 px-3 py-2"
			style={{ background: 'var(--surface)', borderTop: '1px solid var(--rule)' }}
		>
			<div
				title={`Current color ${props.color}`}
				style={{
					width: 28,
					height: 28,
					background: props.color,
					border: '1px solid var(--rule)',
					borderRadius: 3
				}}
			/>
			<div className="flex gap-1">
				{PALETTE.map((c) => {
					const active = props.color.toLowerCase() === c
					return (
						<button
							key={c}
							type="button"
							title={c}
							aria-pressed={active}
							onClick={() => props.onColor(c)}
							style={{
								width: 18,
								height: 18,
								background: c,
								border: active ? '2px solid var(--focus)' : '1px solid var(--rule)',
								borderRadius: 2,
								cursor: 'default'
							}}
						/>
					)
				})}
			</div>
			<label className="ml-2 flex items-center gap-1 text-[11px]" style={{ color: 'var(--text)' }}>
				<span className="opacity-60">Custom</span>
				<input
					type="color"
					value={props.color}
					onChange={(e) => props.onColor(e.target.value)}
					style={{ width: 22, height: 22, padding: 0, border: 'none', background: 'transparent' }}
				/>
			</label>
		</footer>
	)
}
