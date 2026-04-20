import type { ReactNode } from 'react'
import { type LayoutMode, useLayoutMode } from './layoutMode'

type HeaderActionTone = 'default' | 'primary' | 'danger' | 'success'

export type HeaderActionMenuItem = {
	key: string
	label: string
	onClick: () => void
	icon?: ReactNode
	shortcut?: ReactNode
	disabled?: boolean
	hideLabelOnMobile?: boolean
	tone?: HeaderActionTone
	title?: string
	layoutModes?: LayoutMode[]
}

export type HeaderActionSurface = 'sidebar' | 'editor'

type Props = {
	items: HeaderActionMenuItem[]
	surface: HeaderActionSurface
	collapseMode?: 'viewport' | 'container'
}

const toneClasses: Record<HeaderActionTone, string> = {
	default: 'text-base-content/70 hover:text-base-content',
	primary: 'bg-primary text-primary-content hover:bg-primary/90 hover:text-primary-content',
	danger: 'text-error hover:bg-error/10 hover:text-error',
	success: 'text-success hover:bg-success/10 hover:text-success'
}

export function HeaderActionMenu({ items, surface, collapseMode = 'viewport' }: Props) {
	const { mode } = useLayoutMode()
	const visibleItems = items.filter((item) => !item.layoutModes || item.layoutModes.includes(mode))

	if (visibleItems.length === 0) return null

	return (
		<ul
			data-surface={surface}
			data-collapse-mode={collapseMode}
			className="header-action-menu menu menu-horizontal menu-sm rounded-box p-1 gap-1"
		>
			{visibleItems.map((item) => {
				const tone = item.tone ?? 'default'

				return (
					<li key={item.key}>
						<button
							type="button"
							onClick={item.onClick}
							disabled={item.disabled}
							title={item.title ?? item.label}
							aria-label={item.label}
							className={`flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-mono transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${toneClasses[tone]}`}
						>
							{item.icon}
							<span
								data-compact={item.hideLabelOnMobile ? 'true' : undefined}
								className={
									item.hideLabelOnMobile && collapseMode === 'viewport'
										? 'hidden sm:inline'
										: undefined
								}
							>
								{item.label}
							</span>
							{item.shortcut}
						</button>
					</li>
				)
			})}
		</ul>
	)
}
