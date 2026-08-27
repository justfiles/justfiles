import {
	type CSSProperties,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
	useLayoutEffect,
	useRef,
	useState
} from 'react'
import { clampPanelSize, effectiveMode, type Mode } from './attached-agent-layout.ts'

export type AttachedAgentMode = Mode

export interface AttachedAgentSize {
	sheet: number
	sidebar: number
}

export interface AttachedAgentConfig {
	mode: AttachedAgentMode
	open: boolean
	size: AttachedAgentSize
	footer: ReactNode
	panel: ReactNode
	onModeChange: (mode: AttachedAgentMode) => void
	onEffectiveModeChange?: (mode: AttachedAgentMode) => void
	onOpenChange: (open: boolean) => void
	onSizeChange: (size: AttachedAgentSize) => void
}

export function AttachedAgent({
	children,
	agent
}: {
	children: ReactNode
	agent?: AttachedAgentConfig
}) {
	const rootRef = useRef<HTMLDivElement>(null)
	const resizeRef = useRef<{
		mode: AttachedAgentMode
		x: number
		y: number
		size: number
	} | null>(null)
	const [bounds, setBounds] = useState({
		width: Number.POSITIVE_INFINITY,
		height: 0,
		measured: false
	})
	const configured = agent !== undefined

	useLayoutEffect(() => {
		if (!configured || !rootRef.current) return
		const root = rootRef.current
		const read = () =>
			setBounds({ width: root.clientWidth, height: root.clientHeight, measured: true })
		read()
		const observer = new ResizeObserver(read)
		observer.observe(root)
		return () => observer.disconnect()
	}, [configured])

	const mode = agent ? effectiveMode(agent.mode, bounds.width, agent.size.sidebar) : 'sheet'
	const onEffectiveModeChange = agent?.onEffectiveModeChange
	useLayoutEffect(() => {
		if (bounds.measured) onEffectiveModeChange?.(mode)
	}, [bounds.measured, mode, onEffectiveModeChange])

	if (!agent)
		return (
			<div style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
				{children}
			</div>
		)

	const extent = mode === 'sheet' ? bounds.height : bounds.width
	const size = clampPanelSize(mode, agent.size[mode], extent)
	const sidebarAvailable = effectiveMode('sidebar', bounds.width, agent.size.sidebar) === 'sidebar'
	const panelStyle = { '--ds-attached-agent-size': `${size}px` } as CSSProperties

	const resize = (next: number, resizeMode: AttachedAgentMode) => {
		const nextExtent = resizeMode === 'sheet' ? bounds.height : bounds.width
		agent.onSizeChange({
			...agent.size,
			[resizeMode]: clampPanelSize(resizeMode, next, nextExtent)
		})
	}
	const onResizeDown = (event: PointerEvent<HTMLHRElement>) => {
		event.preventDefault()
		event.currentTarget.setPointerCapture(event.pointerId)
		resizeRef.current = { mode, x: event.clientX, y: event.clientY, size }
	}
	const onResizeMove = (event: PointerEvent<HTMLHRElement>) => {
		const start = resizeRef.current
		if (!start) return
		const delta = start.mode === 'sheet' ? start.y - event.clientY : start.x - event.clientX
		resize(start.size + delta, start.mode)
	}
	const onResizeEnd = (event: PointerEvent<HTMLHRElement>) => {
		resizeRef.current = null
		if (event.currentTarget.hasPointerCapture(event.pointerId))
			event.currentTarget.releasePointerCapture(event.pointerId)
	}
	const onResizeKey = (event: KeyboardEvent<HTMLHRElement>) => {
		const grows = mode === 'sheet' ? event.key === 'ArrowUp' : event.key === 'ArrowLeft'
		const shrinks = mode === 'sheet' ? event.key === 'ArrowDown' : event.key === 'ArrowRight'
		if (!grows && !shrinks) return
		event.preventDefault()
		resize(size + (grows ? 1 : -1) * (event.shiftKey ? 40 : 16), mode)
	}
	const chevron = mode === 'sheet' ? (agent.open ? '⌄' : '⌃') : agent.open ? '‹' : '›'

	return (
		<div
			ref={rootRef}
			className="ds-attached-agent"
			data-mode={mode}
			data-open={agent.open}
			style={panelStyle}
			onKeyDownCapture={(event) => {
				if (event.key === 'Escape' && agent.open && mode === 'sheet') {
					event.preventDefault()
					agent.onOpenChange(false)
				}
			}}
		>
			<div className="ds-attached-agent-main">
				<div className="ds-attached-agent-app">{children}</div>
				<button
					type="button"
					className="ds-attached-agent-scrim"
					aria-label="Close agent"
					onClick={() => agent.onOpenChange(false)}
				/>
				<hr
					className="ds-attached-agent-seam"
					aria-label={`Resize agent ${mode}`}
					aria-orientation={mode === 'sheet' ? 'horizontal' : 'vertical'}
					aria-valuenow={Math.round(size)}
					tabIndex={agent.open ? 0 : -1}
					onPointerDown={onResizeDown}
					onPointerMove={onResizeMove}
					onPointerUp={onResizeEnd}
					onPointerCancel={onResizeEnd}
					onKeyDown={onResizeKey}
				/>
				<section
					className="ds-attached-agent-panel"
					aria-label="Agent conversation"
					aria-hidden={!agent.open}
				>
					<header className="ds-attached-agent-panel-controls">
						<button
							type="button"
							disabled={mode === 'sheet' && !sidebarAvailable}
							title={sidebarAvailable ? undefined : 'Widen the window to use the sidebar'}
							onClick={() => agent.onModeChange(mode === 'sheet' ? 'sidebar' : 'sheet')}
						>
							{mode === 'sheet' ? '⇥ Side' : '⌄ Sheet'}
						</button>
						<button
							type="button"
							aria-label="Close agent"
							title="Close agent"
							onClick={() => agent.onOpenChange(false)}
						>
							×
						</button>
					</header>
					<div className="ds-attached-agent-panel-body">{agent.panel}</div>
				</section>
			</div>
			<footer className="ds-window-footer">
				<span className="ds-window-footer-leading" />
				<button
					type="button"
					className="ds-attached-agent-toggle"
					data-open={agent.open}
					aria-expanded={agent.open}
					aria-label={agent.open ? 'Close agent' : `Open agent ${mode}`}
					title={agent.open ? 'Close agent' : `Open agent ${mode}`}
					onClick={() => agent.onOpenChange(!agent.open)}
				>
					{agent.footer}
					<span className="ds-attached-agent-chevron" aria-hidden="true">
						{chevron}
					</span>
				</button>
			</footer>
		</div>
	)
}
