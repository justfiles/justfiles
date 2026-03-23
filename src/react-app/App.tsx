import { useAuth } from '@clerk/clerk-react'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { FiSearch } from 'react-icons/fi'
import { EditorLayout } from './EditorLayout'
import { ModeSelector } from './ModeSelector'
import { useSidebarActions } from './SidebarContext'
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
	const { upsertEntry, refresh } = useSidebarActions()

	const lsText = `ghostore:${userId}:draft:text`
	const lsDirty = `ghostore:${userId}:draft:dirty`
	const lsId = `ghostore:${userId}:draft:id`

	// Editor is bound to localStorage — instant, no loading state
	const [editorText, setEditorText] = useState(() => localStorage.getItem(lsText) ?? '')
	const [hasPendingTimer, setHasPendingTimer] = useState(() => !!localStorage.getItem(lsDirty))
	const draftIdRef = useRef<string | null>(localStorage.getItem(lsId))
	const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	const syncMutation = useMutation({
		mutationFn: async (text: string) => {
			const id = draftIdRef.current
			if (!id) throw new Error('No draft id')
			const token = await getToken()
			if (!token) throw new Error('Missing auth token')
			const res = await fetch('/api/v1/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
				body: JSON.stringify({ id, text })
			})
			if (!res.ok) throw new Error(`Sync failed: ${res.status}`)
		},
		onSuccess: () => {
			localStorage.removeItem(lsDirty)
		}
	})

	// On mount: fetch/create server draft for ID and cross-device sync
	useEffect(() => {
		let cancelled = false
		async function init() {
			try {
				const token = await getToken()
				if (!token || cancelled) return
				const res = await fetch('/api/v1/draft', { headers: { Authorization: `Bearer ${token}` } })
				if (!res.ok || cancelled) return
				const data = (await res.json()) as { id: string; raw_text: string }

				draftIdRef.current = data.id
				localStorage.setItem(lsId, data.id)

				if (!localStorage.getItem(lsDirty)) {
					// No local changes — sync text from server (cross-device)
					setEditorText(data.raw_text)
					localStorage.setItem(lsText, data.raw_text)
				} else {
					// Local changes exist — push them to server now
					syncMutation.mutate(localStorage.getItem(lsText) ?? '')
				}
			} catch {}
		}
		init()
		return () => {
			cancelled = true
		}
	}, [])

	function handleChange(value: string) {
		setEditorText(value)
		localStorage.setItem(lsText, value)
		localStorage.setItem(lsDirty, '1')
	}

	// Debounced background sync on every change
	useEffect(() => {
		if (syncTimer.current) clearTimeout(syncTimer.current)
		if (!localStorage.getItem(lsDirty)) {
			setHasPendingTimer(false)
			return
		}
		setHasPendingTimer(true)
		syncTimer.current = setTimeout(() => {
			setHasPendingTimer(false)
			syncMutation.mutate(editorText)
		}, 3000)
	}, [editorText])

	const submitMutation = useMutation({
		mutationFn: async ({ text, path }: { text: string; path: string }) => {
			const token = await getToken()
			if (!token) throw new Error('Missing auth token')
			const submittedId = draftIdRef.current
			if (!submittedId) throw new Error('No draft id')
			if (syncTimer.current) clearTimeout(syncTimer.current)
			// Promote draft to real memory (keeps same id, so asset refs remain valid)
			const promoteRes = await fetch('/api/v1/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
				body: JSON.stringify({ id: submittedId, text, path })
			})
			if (!promoteRes.ok) throw new Error(`Submit failed: ${promoteRes.status}`)
			// Create new blank draft
			const newDraftRes = await fetch('/api/v1/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
				body: JSON.stringify({ path: '*draft*', text: '' })
			})
			if (!newDraftRes.ok) throw new Error(`Draft reset failed: ${newDraftRes.status}`)
			const { id: newDraftId } = (await newDraftRes.json()) as { id: string }
			return { submittedId, newDraftId }
		},
		onSuccess: (data, { path }) => {
			draftIdRef.current = data.newDraftId
			setEditorText('')
			setHasPendingTimer(false)
			localStorage.setItem(lsText, '')
			localStorage.removeItem(lsDirty)
			localStorage.setItem(lsId, data.newDraftId)
			upsertEntry({ id: data.submittedId, title: null, path, updated_at: '', tags: [], active: 1 })
			refresh()
		}
	})

	function handleSubmit() {
		const text = editorText
		if (!text.trim()) return
		submitMutation.mutate({ text, path: expandTemplate(activeDestination.pathTemplate) })
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
		<EditorLayout
			headerLeft={
				<div className="flex items-center gap-2 min-w-0">
					<span className="text-sm font-medium text-base-content/70 font-mono shrink-0">draft{hasPendingTimer || syncMutation.isPending ? '*' : ''}</span>
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
						disabled={submitMutation.isPending || !editorText.trim()}
						className="btn btn-primary btn-sm font-mono"
					>
						{submitMutation.isPending ? 'Saving…' : 'Submit'}
					</button>
				</>
			}
			value={editorText}
			onChange={handleChange}
			memoryId={draftIdRef.current ?? undefined}
			getToken={getToken}
		/>
	)
}

export default App
