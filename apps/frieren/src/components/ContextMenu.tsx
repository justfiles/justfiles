import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState
} from 'react'

export type ContextMenuItem =
	| { separator: true }
	| {
			label: string
			onSelect: () => void
			disabled?: boolean
	  }

export interface ContextMenuState {
	x: number
	y: number
	items: ContextMenuItem[]
}

export function useContextMenu() {
	const [state, setState] = useState<ContextMenuState | null>(null)
	const open = useCallback((event: ReactMouseEvent, items: ContextMenuItem[]) => {
		event.preventDefault()
		event.stopPropagation()
		if (items.length === 0) return
		setState({ x: event.clientX, y: event.clientY, items })
	}, [])
	const close = useCallback(() => setState(null), [])
	return { state, open, close }
}

export function ContextMenu({
	state,
	onClose
}: {
	state: ContextMenuState | null
	onClose: () => void
}) {
	const ref = useRef<HTMLDivElement>(null)
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

	useLayoutEffect(() => {
		if (!state) {
			setPos(null)
			return
		}
		const el = ref.current
		if (!el) return
		const { offsetWidth: w, offsetHeight: h } = el
		const x = Math.min(state.x, window.innerWidth - w - 4)
		const y = Math.min(state.y, window.innerHeight - h - 4)
		setPos({ x: Math.max(4, x), y: Math.max(4, y) })
	}, [state])

	useEffect(() => {
		if (!state) return
		const onDown = (event: PointerEvent) => {
			if (ref.current && !ref.current.contains(event.target as Node)) onClose()
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onClose()
		}
		const onScroll = () => onClose()
		window.addEventListener('pointerdown', onDown, true)
		window.addEventListener('keydown', onKey, true)
		window.addEventListener('scroll', onScroll, true)
		window.addEventListener('resize', onScroll)
		return () => {
			window.removeEventListener('pointerdown', onDown, true)
			window.removeEventListener('keydown', onKey, true)
			window.removeEventListener('scroll', onScroll, true)
			window.removeEventListener('resize', onScroll)
		}
	}, [state, onClose])

	if (!state) return null

	return (
		<div
			ref={ref}
			role="menu"
			className="ds-menu fixed"
			style={{
				left: pos?.x ?? state.x,
				top: pos?.y ?? state.y,
				zIndex: 10000,
				visibility: pos ? 'visible' : 'hidden'
			}}
			onContextMenu={(event) => event.preventDefault()}
		>
			{state.items.map((item, index) => {
				const key = 'separator' in item ? `sep-${index}` : `item-${index}-${item.label}`
				if ('separator' in item) return <div key={key} className="ds-menu-separator" />
				return (
					<button
						key={key}
						type="button"
						role="menuitem"
						aria-disabled={item.disabled || undefined}
						disabled={item.disabled}
						className="ds-menu-item"
						onClick={() => {
							onClose()
							item.onSelect()
						}}
					>
						{item.label}
					</button>
				)
			})}
		</div>
	)
}
