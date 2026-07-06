import { XIcon } from '@phosphor-icons/react'
import { useEffect } from 'react'
import { MessagesPanel } from '../agent/MessagesPanel'

// Frosted-glass chat panel that overlays the desktop from the right — like macOS
// Notification Center — instead of squishing it: the desktop and dock stay put
// and the panel slides in on top, frosting whatever is underneath. It renders
// inside the desktop region (so it can never cover the menubar) and is inset
// from the edges, making it a floating pane shorter than the full height.
const PANEL_WIDTH = 'clamp(340px, 28vw, 460px)'

export function AgentSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
	useEffect(() => {
		if (!open) return
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onClose()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [open, onClose])

	return (
		<aside
			className="frn-agent-panel"
			style={{
				position: 'absolute',
				top: 12,
				right: 12,
				bottom: 12,
				zIndex: 9500,
				display: 'flex',
				flexDirection: 'column',
				overflow: 'hidden',
				transition: 'transform 0.3s ease-out, opacity 0.3s ease-out',
				width: PANEL_WIDTH,
				transform: open ? 'translateX(0)' : 'translateX(calc(100% + 0.75rem))',
				opacity: open ? 1 : 0,
				borderRadius: 14,
				border: '1px solid rgba(255,255,255,0.35)',
				background: 'linear-gradient(to bottom, rgba(255,255,255,0.58), rgba(255,255,255,0.44))',
				backdropFilter: 'blur(30px) saturate(180%)',
				WebkitBackdropFilter: 'blur(30px) saturate(180%)',
				boxShadow: '0 16px 48px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.6)'
			}}
			inert={!open}
		>
			<MessagesPanel />
			<button
				type="button"
				onClick={onClose}
				aria-label="Close Messages"
				style={{
					position: 'absolute',
					right: 8,
					top: 8,
					zIndex: 10,
					padding: 4,
					border: 'none',
					background: 'transparent',
					color: 'var(--text)',
					opacity: 0.4
				}}
			>
				<XIcon />
			</button>
		</aside>
	)
}
