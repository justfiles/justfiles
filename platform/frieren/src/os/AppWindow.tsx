import { AttachedAgent } from '@justfiles/ui/AttachedAgent'
import type { ReactNode } from 'react'
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
	children
}: {
	id: string
	title: string
	children: ReactNode
}) {
	const dispatch = useOsDispatch()
	const window = useOsStore((s) => s.windows[id])
	const rect = useOsStore((s) => s.placements[id])
	const focused = useOsStore((s) => selectFocusedWindowId(s) === id)
	const zIndex = useOsStore((s) => selectWindowZIndex(s, id))

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
			<AttachedAgent>{children}</AttachedAgent>
		</Window>
	)
}
