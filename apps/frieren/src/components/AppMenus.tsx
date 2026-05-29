import type { Menu } from '@justfiles/app/browser'
import { useEffect, useRef, useState } from 'react'

// macOS-style universal menubar: a row of the focused app's menu titles, each
// opening a dropdown beneath it. Once one is open, hovering a sibling switches
// to it (the macOS behavior); outside-click / Escape closes.
export function AppMenus({ menu }: { menu: Menu }) {
	const rootRef = useRef<HTMLDivElement>(null)
	const [open, setOpen] = useState<number | null>(null)

	useEffect(() => {
		if (open === null) return
		const onDown = (event: PointerEvent) => {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(null)
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setOpen(null)
		}
		window.addEventListener('pointerdown', onDown, true)
		window.addEventListener('keydown', onKey, true)
		return () => {
			window.removeEventListener('pointerdown', onDown, true)
			window.removeEventListener('keydown', onKey, true)
		}
	}, [open])

	// The focused app changed its menus out from under an open index.
	useEffect(() => {
		if (open !== null && open >= menu.length) setOpen(null)
	}, [menu, open])

	if (menu.length === 0) return null

	return (
		<div ref={rootRef} className="flex items-center">
			{menu.map((entry, index) => (
				<div key={entry.title} className="relative">
					<button
						type="button"
						className="ds-menu-title"
						data-active={open === index || undefined}
						onClick={() => setOpen((current) => (current === index ? null : index))}
						onPointerEnter={() => {
							if (open !== null) setOpen(index)
						}}
					>
						{entry.title}
					</button>
					{open === index ? (
						<div
							role="menu"
							className="ds-menu absolute left-0 top-full mt-px"
							style={{ zIndex: 10000 }}
						>
							{entry.items.map((item, itemIndex) => {
								const key =
									'separator' in item ? `sep-${itemIndex}` : `item-${itemIndex}-${item.title}`
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
											setOpen(null)
											item.onSelect()
										}}
									>
										<span className="w-4">{item.checked ? '✓' : ''}</span>
										<span>{item.title}</span>
										{item.shortcut ? (
											<span className="ml-auto pl-6 opacity-60">{item.shortcut}</span>
										) : null}
									</button>
								)
							})}
						</div>
					) : null}
				</div>
			))}
		</div>
	)
}
