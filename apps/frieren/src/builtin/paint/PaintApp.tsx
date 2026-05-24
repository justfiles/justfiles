import { useAuth } from '@clerk/clerk-react'
import {
	ArrowClockwiseIcon,
	ArrowCounterClockwiseIcon,
	FilePlusIcon,
	FloppyDiskIcon
} from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createFsVolume } from '../../fs'
import {
	drawEllipse,
	drawRect,
	fill,
	floodFill,
	restore,
	snapshot,
	stampLine,
	stampPoint,
	toPNG
} from './bitmap'
import { ColorStrip } from './ColorStrip'
import { type Size, type Tool, Toolbar } from './Toolbar'

const CANVAS_W = 800
const CANVAS_H = 600
const UNDO_LIMIT = 30
const SAVE_DIR = '/Paint'

interface Drag {
	startX: number
	startY: number
	prevX: number
	prevY: number
	snap: ImageData
}

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

export function PaintApp() {
	const { getToken } = useAuth()
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken

	const canvasRef = useRef<HTMLCanvasElement>(null)
	const dragRef = useRef<Drag | null>(null)
	const undoRef = useRef<ImageData[]>([])
	const redoRef = useRef<ImageData[]>([])

	const [tool, setTool] = useState<Tool>('pencil')
	const [size, setSize] = useState<Size>(1)
	const [color, setColor] = useState('#000000')
	const [status, setStatus] = useState<string>('')
	const [, setHistoryTick] = useState(0)
	const bumpHistory = useCallback(() => setHistoryTick((t) => t + 1), [])

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
		return { x: e.clientX - rect.left, y: e.clientY - rect.top }
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
		if (!canvas) return
		setStatus('Saving…')
		try {
			const volume = await createFsVolume(() => getTokenRef.current())
			await volume.mkdir(SAVE_DIR, { recursive: true })
			const bytes = await toPNG(canvas)
			const path = `${SAVE_DIR}/untitled-${timestamp()}.png`
			await volume.writeFile(path, bytes)
			setStatus(`Saved ${path}`)
		} catch (cause) {
			setStatus(cause instanceof Error ? cause.message : String(cause))
		}
	}

	const canUndo = undoRef.current.length > 0
	const canRedo = redoRef.current.length > 0

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
				<MenuButton label="New" icon={<FilePlusIcon size={14} />} onClick={handleNew} />
				<MenuButton label="Save" icon={<FloppyDiskIcon size={14} />} onClick={handleSave} />
				<MenuButton
					label="Undo"
					icon={<ArrowCounterClockwiseIcon size={14} />}
					onClick={handleUndo}
					disabled={!canUndo}
				/>
				<MenuButton
					label="Redo"
					icon={<ArrowClockwiseIcon size={14} />}
					onClick={handleRedo}
					disabled={!canRedo}
				/>
				<span className="ml-auto truncate text-[11px] opacity-60">{status}</span>
			</header>

			<div className="flex min-h-0 flex-1">
				<Toolbar tool={tool} size={size} onTool={setTool} onSize={setSize} />
				<div className="min-h-0 flex-1 overflow-auto p-4" style={{ background: '#8a8a86' }}>
					<canvas
						ref={canvasRef}
						width={CANVAS_W}
						height={CANVAS_H}
						onPointerDown={handlePointerDown}
						onPointerMove={handlePointerMove}
						onPointerUp={handlePointerUp}
						onPointerCancel={handlePointerUp}
						style={{
							display: 'block',
							background: '#ffffff',
							boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
							imageRendering: 'pixelated',
							touchAction: 'none',
							cursor: 'crosshair'
						}}
					/>
				</div>
			</div>

			<ColorStrip color={color} onColor={setColor} />
		</div>
	)
}

function MenuButton(props: {
	label: string
	icon: React.ReactNode
	onClick: () => void
	disabled?: boolean
}) {
	return (
		<button
			type="button"
			onClick={props.onClick}
			disabled={props.disabled}
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: 4,
				padding: '3px 8px',
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
			{props.icon}
			<span>{props.label}</span>
		</button>
	)
}
