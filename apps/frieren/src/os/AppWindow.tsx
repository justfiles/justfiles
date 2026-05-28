import type { Store } from '@justfiles/state'
import { useStore } from '@justfiles/state/react'
import type { ReactNode } from 'react'
import { Window } from '../components/Window'
import { selectFocusedWindowId, selectWindowZIndex } from './selectors'
import type { OsAction, OsState } from './state'

// Connects one window to its OS-state slice. Subscribing per id means moving or
// focusing one window only re-renders that window, not the whole desktop.
export function AppWindow({
	store,
	id,
	children
}: {
	store: Store<OsState, OsAction>
	id: string
	children: ReactNode
}) {
	const window = useStore(store, (s) => s.windows[id])
	const focused = useStore(store, (s) => selectFocusedWindowId(s) === id)
	const zIndex = useStore(store, (s) => selectWindowZIndex(s, id))

	if (!window || window.mode === 'minimized') return null

	return (
		<Window
			title={window.title ?? ''}
			rect={window.rect}
			focused={focused}
			zIndex={zIndex}
			fullscreen={window.mode === 'fullscreen'}
			onClose={() => store.dispatch({ type: 'window.close', id })}
			onFocus={() => store.dispatch({ type: 'window.focus', id })}
			onRectCommit={(rect) => store.dispatch({ type: 'window.rectUpdated', id, rect })}
			onFullscreenToggle={() => {
				store.dispatch({ type: 'window.focus', id })
				store.dispatch({
					type: 'window.setMode',
					id,
					mode: window.mode === 'fullscreen' ? 'floating' : 'fullscreen'
				})
			}}
		>
			{children}
		</Window>
	)
}
