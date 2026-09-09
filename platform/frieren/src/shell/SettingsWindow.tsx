import { Settings } from '@justfiles/ui/Settings'
import type { Category, SettingsHost } from '@justfiles/ui/settings/types'
import { useCallback, useEffect, useState } from 'react'
import { Window } from '../components/Window'
import { useOsDispatch, useOsRuntime, useOsStore } from '../os/hooks'
import { selectFocusedWindowId, selectWindowZIndex } from '../os/selectors'
import { SETTINGS_WINDOW_ID as id } from '../os/state'

export function SettingsWindow() {
	const dispatch = useOsDispatch()
	const { settings } = useOsRuntime()
	const [host, setHost] = useState<SettingsHost | null>(null)
	const [error, setError] = useState<string | null>(null)
	const window = useOsStore((state) => state.windows[id])
	const rect = useOsStore((state) => state.placements[id])
	const focused = useOsStore((state) => selectFocusedWindowId(state) === id)
	const zIndex = useOsStore((state) => selectWindowZIndex(state, id))
	const selectCategory = useCallback(
		(category: Category) => dispatch({ type: 'settings.open', category }),
		[dispatch]
	)
	useEffect(() => {
		let live = true
		void settings.then(
			(host) => {
				if (live) setHost(host)
			},
			(error: unknown) => {
				if (live) setError(String(error))
			}
		)
		return () => {
			live = false
		}
	}, [settings])
	if (!window || !rect || window.mode === 'minimized') return null
	return (
		<Window
			title="Settings"
			rect={rect}
			focused={focused}
			zIndex={zIndex}
			fullscreen={window.mode === 'fullscreen'}
			onClose={() => dispatch({ type: 'window.close', id })}
			onFocus={() => dispatch({ type: 'window.focus', id })}
			onRectCommit={(rect) => dispatch({ type: 'window.rectUpdated', id, rect })}
			onFullscreenToggle={() =>
				dispatch({
					type: 'window.setMode',
					id,
					mode: window.mode === 'fullscreen' ? 'floating' : 'fullscreen'
				})
			}
		>
			{host ? (
				<Settings host={host} category={window.category} onCategoryChange={selectCategory} />
			) : (
				<p>{error ?? 'Loading settings…'}</p>
			)}
		</Window>
	)
}
