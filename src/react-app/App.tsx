import { useAuth } from '@clerk/clerk-react'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { FiSearch } from 'react-icons/fi'
import { useDraft } from './draft'
import { MemoryEditor } from './MemoryEditor'
import { ModeSelector } from './ModeSelector'
import { useSidebarActions } from './SidebarContext'
import { useSyncRuntimeStatus } from './sync'
import {
	type Destination,
	expandTemplate,
	getActiveDestination,
	loadSettings,
	saveSettings
} from './settings'

function App() {
	const { getToken, userId } = useAuth()
	const [settings] = useState(() => loadSettings(userId!))
	const [activeDestination, setActiveDestination] = useState<Destination>(() =>
		getActiveDestination(settings)
	)
	const { refresh } = useSidebarActions()
	const [draftEditorVersion, setDraftEditorVersion] = useState(0)
	const { id, isLoading, submit } = useDraft()
	const { isOnline } = useSyncRuntimeStatus()

	const submitMutation = useMutation({
		mutationFn: async ({ path }: { path: string }) => {
			await submit(path)
			return { path }
		},
		onSuccess: () => {
			setDraftEditorVersion((v) => v + 1)
			refresh()
		}
	})

	function handleSubmit() {
		submitMutation.mutate({
			path: expandTemplate(activeDestination.pathTemplate)
		})
	}

	const handleSubmitRef = useRef(handleSubmit)
	handleSubmitRef.current = handleSubmit

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				handleSubmitRef.current()
			}
		}
		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [])

	function handleSelectDestination(dest: Destination) {
		setActiveDestination(dest)
		saveSettings({ lastUsedDestinationId: dest.id }, userId!)
	}

	return (
		<MemoryEditor
			key={draftEditorVersion}
			id={id}
			isLoading={isLoading}
			getToken={getToken}
			headerLeft={
				<div className="flex items-center gap-2 min-w-0">
					<span className="text-sm font-medium text-base-content/70 font-mono shrink-0">
						draft{submitMutation.isPending ? '*' : ''}
					</span>
					<ModeSelector
						destinations={settings.destinations}
						active={activeDestination}
						onSelect={handleSelectDestination}
					/>
				</div>
			}
			headerRight={
				<>
					<button
						type="button"
						onClick={() => window.dispatchEvent(new Event('open-command-palette'))}
						className="flex items-center gap-1.5 px-3 h-8 rounded-lg border border-base-300 bg-base-200 hover:bg-base-300 text-base-content/50 text-sm font-mono"
					>
						<FiSearch className="w-3.5 h-3.5 shrink-0" />
						<span className="hidden sm:inline">Search</span>
						<kbd className="kbd kbd-xs hidden sm:inline">⌘K</kbd>
					</button>
					<button
						type="button"
						onClick={handleSubmit}
						disabled={submitMutation.isPending || !isOnline}
						className="btn btn-primary btn-sm font-mono"
					>
						{submitMutation.isPending ? 'Saving…' : 'Submit'}
					</button>
				</>
			}
		/>
	)
}

export default App
