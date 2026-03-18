import { useAuth } from '@clerk/clerk-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { FiSearch } from 'react-icons/fi'
import { AuthWall } from './AuthWall'
import { EditorLayout } from './EditorLayout'
import { useSidebarActions } from './SidebarContext'

type Memory = {
	id: string
	scope: string
	title: string | null
	raw_text: string
	path: string
	occurred_at: string | null
	source: string | null
	created_at: string
	updated_at: string
	tags: string[]
	links: unknown[]
}

export function MemoryPage() {
	const { id } = useParams({ strict: false }) as { id: string }
	const navigate = useNavigate()
	const { getToken, isLoaded, isSignedIn } = useAuth()
	const [editorText, setEditorText] = useState('')
	const [hasPendingTimer, setHasPendingTimer] = useState(false)
	const loadedTextRef = useRef<string | null>(null)
	const staleTextRef = useRef<string>('')
	const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const { upsertEntry } = useSidebarActions()

	const memoryQuery = useQuery({
		queryKey: ['memory', id],
		queryFn: async () => {
			const token = await getToken()
			if (!token) throw new Error('Missing auth token')
			const res = await fetch(`/api/v1/memory/${encodeURIComponent(id)}`, {
				headers: { Authorization: `Bearer ${token}` },
			})
			if (!res.ok) throw new Error(`Failed: ${res.status}`)
			return res.json() as Promise<Memory>
		},
		enabled: isLoaded && !!isSignedIn,
	})

	// Reset editor when navigating to a different memory
	useEffect(() => {
		loadedTextRef.current = null
		setEditorText('')
	}, [id])

	// Keep stale text for blur-while-loading effect
	useEffect(() => {
		if (editorText) staleTextRef.current = editorText
	}, [editorText])

	// Sync editor text on load
	useEffect(() => {
		if (memoryQuery.data && loadedTextRef.current === null) {
			setEditorText(memoryQuery.data.raw_text)
			loadedTextRef.current = memoryQuery.data.raw_text
		}
	}, [memoryQuery.data])

	const saveMutation = useMutation({
		mutationFn: async (text: string) => {
			const token = await getToken()
			if (!token) throw new Error('Missing auth token')
			const res = await fetch('/api/v1/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
				body: JSON.stringify({ id: memoryQuery.data!.id, text }),
			})
			if (!res.ok) throw new Error(`Save failed: ${res.status}`)
			return text
		},
		onSuccess: (text) => {
			loadedTextRef.current = text
			if (memoryQuery.data) {
				upsertEntry({
					id: memoryQuery.data.id,
					title: memoryQuery.data.title,
					path: memoryQuery.data.path,
					updated_at: new Date().toISOString(),
					tags: memoryQuery.data.tags,
				})
			}
		},
	})

	useEffect(() => {
		if (!memoryQuery.data || editorText === loadedTextRef.current) return
		setHasPendingTimer(true)
		if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
		autoSaveTimer.current = setTimeout(() => {
			setHasPendingTimer(false)
			saveMutation.mutate(editorText)
		}, 3000)
	}, [editorText])

	if (!isLoaded) return <p className="m-8">Loading…</p>
	if (!isSignedIn) return <AuthWall />
	if (memoryQuery.isError) return <p className="m-8 text-error">Failed to load memory</p>

	const autoSaveStatus = hasPendingTimer
		? 'pending'
		: saveMutation.isPending
			? 'saving'
			: saveMutation.isSuccess
				? 'saved'
				: saveMutation.isError
					? 'error'
					: 'idle'

	const saveLabel =
		autoSaveStatus === 'pending'
			? 'Unsaved changes…'
			: autoSaveStatus === 'saving'
				? 'Saving…'
				: autoSaveStatus === 'saved'
					? 'Saved'
					: autoSaveStatus === 'error'
						? 'Save failed'
						: null

	const isLoading = memoryQuery.isPending

	return (
		<EditorLayout
			header={
				<div className="flex items-center w-full gap-2">
					{memoryQuery.data?.title && (
						<span className="text-sm font-bold text-base-content/70 truncate">{memoryQuery.data.title}</span>
					)}
					<div className="flex items-center gap-2 shrink-0 ml-auto">
						<button
							type="button"
							onClick={() => window.dispatchEvent(new Event('open-command-palette'))}
							className="flex items-center gap-2 px-3 h-8 rounded-lg border border-base-300 bg-base-200 hover:bg-base-300 text-base-content/50 text-sm font-mono transition-colors cursor-pointer"
						>
							<FiSearch className="w-3.5 h-3.5 shrink-0" />
							<span>Search</span>
							<kbd className="kbd kbd-xs ml-1">⌘K</kbd>
						</button>
						<button
							type="button"
							onClick={() => navigate({ to: '/' })}
							className="btn btn-neutral btn-sm font-mono"
						>
							New
						</button>
					</div>
				</div>
			}
			value={isLoading ? staleTextRef.current : editorText}
			onChange={isLoading ? () => {} : setEditorText}
			isLoading={isLoading}
			minibufferLeft={memoryQuery.data?.path}
			minibufferRight={
				<span
					className={
						autoSaveStatus === 'saved'
							? 'text-success'
							: autoSaveStatus === 'error'
								? 'text-error'
								: ''
					}
				>
					{saveLabel}
				</span>
			}
		/>
	)
}
