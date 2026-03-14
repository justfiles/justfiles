import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FiCheck, FiChevronUp } from 'react-icons/fi'
import type { Destination } from './settings'

type Props = {
	destinations: Destination[]
	active: Destination
	onSelect: (dest: Destination) => void
}

export function ModeSelector({ destinations, active, onSelect }: Props) {
	const [open, setOpen] = useState(false)
	const triggerRef = useRef<HTMLButtonElement>(null)
	const menuRef = useRef<HTMLDivElement>(null)
	const [menuPos, setMenuPos] = useState<{ bottom: number; left: number }>({ bottom: 0, left: 0 })

	// Compute position above the trigger when opening
	useEffect(() => {
		if (!open || !triggerRef.current) return
		const rect = triggerRef.current.getBoundingClientRect()
		setMenuPos({
			bottom: window.innerHeight - rect.top + 6,
			left: rect.left,
		})
	}, [open])

	// Close on outside click
	useEffect(() => {
		if (!open) return
		function onPointerDown(e: PointerEvent) {
			if (
				triggerRef.current?.contains(e.target as Node) ||
				menuRef.current?.contains(e.target as Node)
			) return
			setOpen(false)
		}
		document.addEventListener('pointerdown', onPointerDown)
		return () => document.removeEventListener('pointerdown', onPointerDown)
	}, [open])

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="flex items-center gap-1 hover:text-base-content transition-colors cursor-pointer"
			>
				<span>{active.name.toLowerCase()}</span>
				<FiChevronUp className="w-3 h-3 opacity-50" />
			</button>

			{open && createPortal(
				<div
					ref={menuRef}
					style={{ position: 'fixed', bottom: menuPos.bottom, left: menuPos.left }}
					className="min-w-[140px] bg-base-100 border border-base-200 rounded-lg shadow-lg overflow-hidden z-50 text-xs font-mono"
				>
					<ul className="menu menu-xs p-1">
						{destinations.map((dest) => (
							<li key={dest.id}>
								<button
									type="button"
									onClick={() => {
										onSelect(dest)
										setOpen(false)
									}}
									className={`flex items-center justify-between gap-4 ${dest.id === active.id ? 'font-semibold active' : ''}`}
								>
									<span>{dest.name}</span>
									{dest.id === active.id && (
									<FiCheck className="w-3.5 h-3.5 text-primary shrink-0" />
									)}
								</button>
							</li>
						))}
					</ul>
				</div>,
				document.body,
			)}
		</>
	)
}
