import { useAuth } from '@clerk/clerk-react'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { FiSearch } from 'react-icons/fi'
import './App.css'
import { AuthWall } from './AuthWall'
import { EditorLayout } from './EditorLayout'
import { ModeSelector } from './ModeSelector'
import { useSidebarActions } from './SidebarContext'
import {
	type Destination,
	expandTemplate,
	getActiveDestination,
	loadSettings,
	saveSettings,
} from './settings'

const LS_KEY = 'ghostore:draft'

function App() {
	const { getToken, isLoaded, isSignedIn } = useAuth()
	const [editorText, setEditorText] = useState(() => localStorage.getItem(LS_KEY) ?? '')
	const [settings] = useState(() => loadSettings())
	const [activeDestination, setActiveDestination] = useState<Destination>(() => getActiveDestination(settings))
	const { upsertEntry, refresh } = useSidebarActions()

	// Persist draft to localStorage
	useEffect(() => {
		localStorage.setItem(LS_KEY, editorText)
	}, [editorText])

	const captureMutation = useMutation({
		mutationFn: async ({ text, path }: { text: string; path: string }) => {
			const token = await getToken()
			if (!token) throw new Error('Missing auth token')
			const res = await fetch('/api/v1/capture', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
				body: JSON.stringify({ text, path }),
			})
			return res.json() as Promise<{ id: string }>
		},
		onSuccess: (data: { id: string }, { path }: { text: string; path: string }) => {
			setEditorText('')
			localStorage.removeItem(LS_KEY)
			// Optimistic placeholder so the entry appears immediately
			upsertEntry({ id: data.id, title: null, path, updated_at: '', tags: [] })
			// Full refresh to replace the placeholder with real server data (title, updated_at)
			refresh()
		},
	})

	function handleSubmit() {
		const text = editorText
		if (!text.trim()) return
		captureMutation.mutate({ text, path: expandTemplate(activeDestination.pathTemplate) })
	}

	const handleSubmitRef = useRef(handleSubmit)
	handleSubmitRef.current = handleSubmit

	// cmd+enter = submit
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

	if (!isLoaded) return <p className="m-8">Loading…</p>
	if (!isSignedIn) return <AuthWall />

	function handleSelectDestination(dest: Destination) {
		setActiveDestination(dest)
		saveSettings({ lastUsedDestinationId: dest.id })
	}

	const submitStatus = captureMutation.isSuccess ? `Saved as ${captureMutation.data?.id}` : null
	const errorMessage = captureMutation.isError ? 'Error saving memory' : null

	const header = (
		<div className="flex items-center gap-2 ml-auto">
			<button type="button" onClick={() => window.dispatchEvent(new Event('open-command-palette'))} className="flex items-center gap-2 px-3 h-8 rounded-lg border border-base-300 bg-base-200 hover:bg-base-300 text-base-content/50 text-sm font-mono transition-colors cursor-pointer">
				<FiSearch className="w-3.5 h-3.5 shrink-0" />
				<span>Search</span>
				<kbd className="kbd kbd-xs ml-1">⌘K</kbd>
			</button>
			<button type="button" onClick={handleSubmit} className="btn btn-neutral btn-sm font-mono">
				Submit
			</button>
		</div>
	)

	return (
		<EditorLayout
			header={header}
			value={editorText}
			onChange={setEditorText}
			minibufferLeft={
				<ModeSelector
					destinations={settings.destinations}
					active={activeDestination}
					onSelect={handleSelectDestination}
				/>
			}
			minibufferRight={
				<span className={errorMessage ? 'text-error' : ''}>{errorMessage ?? submitStatus}</span>
			}
		/>
	)
}

export default App
