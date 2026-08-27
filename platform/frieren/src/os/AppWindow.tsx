import { AttachedAgent, type AttachedAgentMode } from '@justfiles/ui/AttachedAgent'
import { type ReactNode, useCallback, useState } from 'react'
import { AgentAvatar } from '../agent/AgentAvatar'
import { useAgentSession } from '../agent/hooks'
import { MessagesPanel } from '../agent/MessagesPanel'
import { Window } from '../components/Window'
import { useOsDispatch, useOsStore } from './hooks'
import { selectFocusedWindowId, selectWindowZIndex } from './selectors'

// Connects one window to its OS-state slice. Subscribing per id means moving or
// focusing one window only re-renders that window, not the whole desktop. The
// title is supplied by the shell (derived from app-catalog metadata), not read
// from OS state, so it tracks live catalog changes.
export function AppWindow({
	id,
	title,
	onPersonalize,
	children
}: {
	id: string
	title: string
	onPersonalize: () => void
	children: ReactNode
}) {
	const dispatch = useOsDispatch()
	const window = useOsStore((s) => s.windows[id])
	const rect = useOsStore((s) => s.placements[id])
	const focused = useOsStore((s) => selectFocusedWindowId(s) === id)
	const zIndex = useOsStore((s) => selectWindowZIndex(s, id))
	const assistant = useOsStore((s) => s.assistant)
	const agent = useAgentSession(id)
	const [sheetOpen, setSheetOpen] = useState(false)
	const [sidebarReady, setSidebarReady] = useState(false)
	const requestedOpen =
		assistant.mode === 'sidebar' ? sidebarReady && Boolean(assistant.open[id]) : sheetOpen
	const agentOpen = requestedOpen || agent.isStreaming
	const markSidebarReady = useCallback((mode: AttachedAgentMode) => {
		if (mode === 'sidebar') setSidebarReady(true)
	}, [])

	// An open window always has a placement (seeded on open), so a missing rect
	// means the window isn't really open — render nothing rather than guess.
	if (!window || !rect || window.mode === 'minimized') return null

	return (
		<Window
			title={title}
			rect={rect}
			focused={focused}
			zIndex={zIndex}
			fullscreen={window.mode === 'fullscreen'}
			onClose={() => dispatch({ type: 'window.close', id })}
			onFocus={() => dispatch({ type: 'window.focus', id })}
			onRectCommit={(rect) => dispatch({ type: 'window.rectUpdated', id, rect })}
			onFullscreenToggle={() => {
				dispatch({ type: 'window.focus', id })
				dispatch({
					type: 'window.setMode',
					id,
					mode: window.mode === 'fullscreen' ? 'floating' : 'fullscreen'
				})
			}}
		>
			<AttachedAgent
				agent={
					id.startsWith('.')
						? undefined
						: {
								mode: assistant.mode,
								open: agentOpen,
								size: assistant.size,
								footer: (
									<AgentAvatar
										url={agent.avatarUrl}
										faces={agent.avatarFaces}
										expression={agent.expression}
										streaming={agent.isStreaming}
										personalized={agent.personalized}
										size={16}
									/>
								),
								panel: agentOpen ? (
									<MessagesPanel agentId={id} onPersonalize={onPersonalize} />
								) : null,
								onModeChange: (mode) => {
									if (mode === 'sheet') {
										setSheetOpen(agentOpen)
										dispatch({ type: 'assistant.setOpen', id, open: false })
									} else {
										setSheetOpen(false)
										dispatch({ type: 'assistant.setOpen', id, open: agentOpen })
									}
									dispatch({ type: 'assistant.setMode', mode })
								},
								onEffectiveModeChange: markSidebarReady,
								onOpenChange: (open) => {
									if (!open && agent.isStreaming) return
									if (assistant.mode === 'sidebar')
										dispatch({ type: 'assistant.setOpen', id, open })
									else setSheetOpen(open)
								},
								onSizeChange: (size) => dispatch({ type: 'assistant.setSize', size })
							}
				}
			>
				{children}
			</AttachedAgent>
		</Window>
	)
}
