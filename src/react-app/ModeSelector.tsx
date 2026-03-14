import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
					<path fillRule="evenodd" d="M11.78 9.78a.75.75 0 0 1-1.06 0L8 7.06 5.28 9.78a.75.75 0 0 1-1.06-1.06l3.25-3.25a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06Z" clipRule="evenodd" />
				</svg>
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
										<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-primary shrink-0">
											<path fillRule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" clipRule="evenodd" />
										</svg>
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
