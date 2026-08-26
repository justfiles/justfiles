import type { ReactNode } from 'react'

export function AttachedAgent({ children }: { children: ReactNode }) {
	return (
		<div style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
			{children}
		</div>
	)
}
