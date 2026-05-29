import type { Client } from '@justfiles/app'
import { defineGUI } from '@justfiles/app/browser'
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initialState, type PaintApp, type PaintState, type Size, type Tool } from './app.ts'
import {
	canvasToPngBase64,
	drawEllipse,
	drawRect,
	fill,
	floodFill,
	restore,
	snapshot,
	stampLine,
	stampPoint
} from './bitmap.ts'

const CANVAS_W = 800
const CANVAS_H = 600
const UNDO_LIMIT = 30

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

interface Drag {
	startX: number
	startY: number
	prevX: number
	prevY: number
	snap: ImageData
}

function Paint({ state, client }: { state: PaintState; client: Client<PaintApp> }) {
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const dragRef = useRef<Drag | null>(null)
	const undoRef = useRef<ImageData[]>([])
	const redoRef = useRef<ImageData[]>([])
	const [, setHistoryTick] = useState(0)
	const [busy, setBusy] = useState(false)
	const bumpHistory = useCallback(() => setHistoryTick((t) => t + 1), [])

	const { tool, size, color, lastSavedPath, lastError } = state

	const getCtx = () => canvasRef.current?.getContext('2d', { willReadFrequently: true }) ?? null

	useEffect(() => {
		const ctx = canvasRef.current?.getContext('2d', { willReadFrequently: true })
		if (!ctx) return
		ctx.imageSmoothingEnabled = false
		fill(ctx, '#ffffff')
	}, [])

	const pushUndo = useCallback(
		(snap: ImageData) => {
			undoRef.current.push(snap)
			if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift()
			redoRef.current = []
			bumpHistory()
		},
		[bumpHistory]
	)

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
		const { x, y } = pos(e)
		const snap = snapshot(ctx)
		pushUndo(snap)
		dragRef.current = { startX: x, startY: y, prevX: x, prevY: y, snap }

		if (tool === 'pencil') stampPoint(ctx, x, y, size, color)
		else if (tool === 'eraser') stampPoint(ctx, x, y, size, '#ffffff')
		else if (tool === 'fill') {
			floodFill(ctx, x, y, color)
			dragRef.current = null
		}
	}

	const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const drag = dragRef.current
		const ctx = getCtx()
		if (!drag || !ctx) return

		if (tool === 'pencil' || tool === 'eraser') {
			const strokeColor = tool === 'eraser' ? '#ffffff' : color
			const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? []
			const points = coalesced.length > 0 ? coalesced : [e.nativeEvent]
			for (const ev of points) {
				const p = pos(ev)
				stampLine(ctx, drag.prevX, drag.prevY, p.x, p.y, size, strokeColor)
				drag.prevX = p.x
				drag.prevY = p.y
			}
			return
		}

		const p = pos(e)
		restore(ctx, drag.snap)
		if (tool === 'line') stampLine(ctx, drag.startX, drag.startY, p.x, p.y, size, color)
		else if (tool === 'rect') drawRect(ctx, drag.startX, drag.startY, p.x, p.y, size, color)
		else if (tool === 'ellipse') drawEllipse(ctx, drag.startX, drag.startY, p.x, p.y, size, color)
	}

	const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const canvas = canvasRef.current
		if (canvas?.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
		dragRef.current = null
	}

	const handleUndo = () => {
		const ctx = getCtx()
		if (!ctx || undoRef.current.length === 0) return
		redoRef.current.push(snapshot(ctx))
		restore(ctx, undoRef.current.pop() as ImageData)
		bumpHistory()
	}

	const handleRedo = () => {
		const ctx = getCtx()
		if (!ctx || redoRef.current.length === 0) return
		undoRef.current.push(snapshot(ctx))
		restore(ctx, redoRef.current.pop() as ImageData)
		bumpHistory()
	}

	const handleNew = () => {
		const ctx = getCtx()
		if (!ctx) return
		pushUndo(snapshot(ctx))
		fill(ctx, '#ffffff')
	}

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

	const canUndo = undoRef.current.length > 0
	const canRedo = redoRef.current.length > 0
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
