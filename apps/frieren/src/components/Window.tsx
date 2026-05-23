import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react'

export function Window({
	title,
	onClose,
	onFocus,
	focused,
	zIndex,
	initialOffset = 0,
	children
}: {
	title: string
	onClose: () => void
	onFocus?: () => void
	focused?: boolean
	zIndex?: number
	initialOffset?: number
	children: ReactNode
}) {
	const [pos, setPos] = useState({ x: 80 + initialOffset, y: 40 + initialOffset })
	const dragRef = useRef<{ dx: number; dy: number } | null>(null)

	useEffect(() => {
		if (!focused) return
		const handler = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault()
				onClose()
			}
		}
		window.addEventListener('keydown', handler, { capture: true })
		return () => window.removeEventListener('keydown', handler, { capture: true })
	}, [focused, onClose])

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		event.currentTarget.setPointerCapture(event.pointerId)
		dragRef.current = { dx: event.clientX - pos.x, dy: event.clientY - pos.y }
	}
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		if (!dragRef.current) return
		setPos({ x: event.clientX - dragRef.current.dx, y: event.clientY - dragRef.current.dy })
	}
	const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
		dragRef.current = null
		event.currentTarget.releasePointerCapture(event.pointerId)
	}

	return (
		<div
			onPointerDownCapture={onFocus}
			className="absolute flex flex-col overflow-hidden rounded-md shadow-[0_20px_50px_rgba(0,0,0,0.35)]"
			style={{
				left: pos.x,
				top: pos.y,
				width: 720,
				height: 520,
				zIndex,
				background: '#ffffff',
				border: '1px solid var(--rule)',
				color: 'var(--text)',
				fontFamily: 'var(--font-ui)',
				fontSize: 'var(--text-ui)'
			}}
		>
			<div
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				className="flex h-7 flex-none cursor-default select-none items-center gap-2 px-2"
				style={{ background: 'var(--surface)', borderBottom: '1px solid var(--rule)' }}
			>
				<button
					type="button"
					aria-label="Close"
					onPointerDown={(event) => event.stopPropagation()}
					onClick={onClose}
					className="size-3 rounded-full"
					style={{ background: '#ff5f57', border: '1px solid rgba(0,0,0,0.18)' }}
				/>
				<span className="flex-1 text-center" style={{ opacity: focused ? 1 : 0.55 }}>
					{title}
				</span>
				<span className="w-3" />
			</div>
			<div className="flex-1 overflow-hidden">{children}</div>
		</div>
	)
}
