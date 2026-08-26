import type { ReactNode } from 'react'

type AppHeaderProps = {
	leading?: ReactNode
	title?: ReactNode
	trailing?: ReactNode
	secondary?: ReactNode
	safeArea?: boolean
}

export function AppHeader({
	leading,
	title,
	trailing,
	secondary,
	safeArea = true
}: AppHeaderProps) {
	return (
		<header className="shrink-0 border-b border-base-200 bg-base-100/90 backdrop-blur supports-[backdrop-filter]:bg-base-100/80">
			<div
				className={`${safeArea ? 'safe-area-header pb-2' : 'py-2'} flex min-h-12 items-center gap-2 px-3`}
			>
				{leading ? <div className="shrink-0 flex items-center gap-2">{leading}</div> : null}
				<div className="min-w-0 flex-1">{title}</div>
				{trailing ? <div className="shrink-0 flex items-center gap-2">{trailing}</div> : null}
			</div>
			{secondary ? (
				<div className="flex min-h-11 items-center gap-2 border-t border-base-200 px-3 py-1.5">
					{secondary}
				</div>
			) : null}
		</header>
	)
}
