import { useAuth } from '@clerk/clerk-react'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { FiSearch } from 'react-icons/fi'
import { HeaderActionMenu } from './HeaderActionMenu'
import { useDraft } from './draft'
import { MemoryEditor } from './MemoryEditor'
import { ModeSelector } from './ModeSelector'
import {
	type Destination,
	expandTemplate,
	getActiveDestination,
	loadSettings,
	saveSettings
} from './settings'

function useOnlineStatus() {
	const [isOnline, setIsOnline] = useState(() => navigator.onLine)

	useEffect(() => {
		function syncOnlineState() {
			setIsOnline(navigator.onLine)
		}

		window.addEventListener('online', syncOnlineState)
		window.addEventListener('offline', syncOnlineState)

		return () => {
			window.removeEventListener('online', syncOnlineState)
			window.removeEventListener('offline', syncOnlineState)
		}
	}, [])

	return isOnline
}

function App() {
	const { userId } = useAuth()
	const [settings] = useState(() => loadSettings(userId!))
	const [activeDestination, setActiveDestination] = useState<Destination>(() =>
		getActiveDestination(settings)
	)
	const [draftEditorVersion, setDraftEditorVersion] = useState(0)
	const { id, isLoading, content, save, submit, uploadAsset, getAssetUrl, loadAssetBlob } = useDraft()
	const isOnline = useOnlineStatus()

	const submitMutation = useMutation({
		mutationFn: async ({ path }: { path: string }) => {
			await submit(path)
			return { path }
		},
		onSuccess: () => {
			setDraftEditorVersion((v) => v + 1)
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
			content={content}
			onSave={save}
			onUploadAsset={uploadAsset}
			resolveAssetUrl={getAssetUrl}
			readAssetBlob={loadAssetBlob}
			isLoading={isLoading}
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
				<HeaderActionMenu
					items={[
						{
							key: 'search',
							label: 'Search',
							onClick: () => window.dispatchEvent(new Event('open-command-palette')),
							icon: <FiSearch className="w-3.5 h-3.5 shrink-0" />,
							shortcut: <kbd className="kbd kbd-xs hidden sm:inline">⌘K</kbd>,
							hideLabelOnMobile: true
						},
						{
							key: 'submit',
							label: submitMutation.isPending ? 'Saving…' : 'Submit',
							onClick: handleSubmit,
							disabled: submitMutation.isPending || !isOnline,
							tone: 'primary'
						}
					]}
				/>
			}
		/>
	)
}

export default App
