import type { ReactNode } from 'react'

export function Menubar({ children }: { children: ReactNode }) {
	return (
		<header
			className="flex flex-none items-center justify-between gap-2 px-2"
			style={{
				height: 'var(--menubar-height)',
				background: 'var(--surface)',
				color: 'var(--text)',
				borderBottom: '1px solid var(--rule)',
				fontFamily: 'var(--font-ui)',
				fontSize: 'var(--text-ui)'
			}}
		>
			{children}
		</header>
	)
}
