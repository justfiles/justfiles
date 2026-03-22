import { useAuth } from '@clerk/clerk-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import React, { useEffect, useRef, useState } from 'react'
import { FiArchive, FiSearch } from 'react-icons/fi'
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
	const { getToken, userId } = useAuth()
	const hasDraft = !!(userId && localStorage.getItem(`ghostore:${userId}:draft:text`)?.trim())
	const [editorText, setEditorText] = useState('')
	const [hasPendingTimer, setHasPendingTimer] = useState(false)
	const [editingTitle, setEditingTitle] = useState(false)
	const [titleDraft, setTitleDraft] = useState('')
	const titleInputRef = useRef<HTMLInputElement>(null)
	const loadedTextRef = useRef<string | null>(null)
	const staleTextRef = useRef<string>('')
	const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const { upsertEntry, removeEntry } = useSidebarActions()
	const queryClient = useQueryClient()

	const memoryQuery = useQuery({
		queryKey: ['memory', id],
		queryFn: async () => {
			const token = await getToken()
			if (!token) throw new Error('Missing auth token')
			const res = await fetch(`/api/v1/memory/${encodeURIComponent(id)}`, {
				headers: { Authorization: `Bearer ${token}` }
			})
			if (!res.ok) throw new Error(`Failed: ${res.status}`)
			return res.json() as Promise<Memory>
		},
		enabled: true
	})

	// Keep stale text for blur-while-loading effect
	if (editorText) staleTextRef.current = editorText

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
				body: JSON.stringify({ id: memoryQuery.data!.id, text })
			})
			if (!res.ok) throw new Error(`Save failed: ${res.status}`)
			return text
		},
		onSuccess: (text) => {
			loadedTextRef.current = text
			const now = new Date().toISOString()
			queryClient.setQueryData<Memory>(['memory', id], (old) =>
				old ? { ...old, raw_text: text, updated_at: now } : old
			)
			if (memoryQuery.data) {
				upsertEntry({
					id: memoryQuery.data.id,
					title: memoryQuery.data.title,
					path: memoryQuery.data.path,
					updated_at: now,
					tags: memoryQuery.data.tags
				})
			}
		}
	})

	const saveTitleMutation = useMutation({
		mutationFn: async (title: string) => {
			const token = await getToken()
			if (!token) throw new Error('Missing auth token')
			const res = await fetch('/api/v1/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
				body: JSON.stringify({ id: memoryQuery.data!.id, title: title || null })
			})
			if (!res.ok) throw new Error(`Save failed: ${res.status}`)
			return title
		},
		onSuccess: (title) => {
			const now = new Date().toISOString()
			queryClient.setQueryData<Memory>(['memory', id], (old) =>
				old ? { ...old, title: title || null, updated_at: now } : old
			)
			if (memoryQuery.data) {
				upsertEntry({
					id: memoryQuery.data.id,
					title: title || null,
					path: memoryQuery.data.path,
					updated_at: now,
					tags: memoryQuery.data.tags
				})
			}
		}
	})

	function startEditingTitle() {
		setTitleDraft(memoryQuery.data?.title ?? '')
		setEditingTitle(true)
		setTimeout(() => titleInputRef.current?.select(), 0)
	}

	function commitTitle() {
		setEditingTitle(false)
		const trimmed = titleDraft.trim()
		if (trimmed !== (memoryQuery.data?.title ?? '')) {
			saveTitleMutation.mutate(trimmed)
		}
	}

	function onTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
		if (e.key === 'Enter') {
			e.preventDefault()
			commitTitle()
		} else if (e.key === 'Escape') {
			setEditingTitle(false)
		}
	}

	const archiveMutation = useMutation({
		mutationFn: async () => {
			const token = await getToken()
			if (!token) throw new Error('Missing auth token')
			const res = await fetch(`/api/v1/memory/${encodeURIComponent(id)}/archive`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` }
			})
			if (!res.ok) throw new Error(`Archive failed: ${res.status}`)
		},
		onSuccess: () => {
			removeEntry(id)
			navigate({ to: '/' })
		}
	})

	useEffect(() => {
		if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
		if (!memoryQuery.data || editorText === loadedTextRef.current) {
			setHasPendingTimer(false)
			return
		}
		setHasPendingTimer(true)
		autoSaveTimer.current = setTimeout(() => {
			setHasPendingTimer(false)
			saveMutation.mutate(editorText)
		}, 3000)
	}, [editorText])

	if (memoryQuery.isError) return <p className="m-8 text-error">Failed to load memory</p>

	const saveStatus = hasPendingTimer
		? { label: 'Unsaved changes…', cls: 'text-base-content/50' }
		: saveMutation.isPending
			? { label: 'Saving…', cls: 'text-base-content/50' }
			: saveMutation.isSuccess
				? { label: 'Saved', cls: 'text-success' }
				: saveMutation.isError
					? { label: 'Save failed', cls: 'text-error' }
					: null

	const isLoading = memoryQuery.isPending

	return (
		<EditorLayout
			headerLeft={
				memoryQuery.data ? (
					editingTitle ? (
						<input
							ref={titleInputRef}
							type="text"
							value={titleDraft}
							onChange={(e) => setTitleDraft(e.target.value)}
							onBlur={commitTitle}
							onKeyDown={onTitleKeyDown}
							placeholder="Untitled"
							className="block w-full text-sm font-medium bg-transparent border-b border-base-content/30 outline-none text-base-content/70 placeholder:text-base-content/30"
						/>
					) : (
						<button
							type="button"
							onClick={startEditingTitle}
							className="block w-full text-left text-sm font-medium text-base-content/70 truncate hover:text-base-content transition-colors cursor-text"
						>
							{memoryQuery.data.title ?? <span className="text-base-content/30 italic">Untitled</span>}
						</button>
					)
				) : undefined
			}
			headerRight={
				<>
					{saveStatus && (
						<span className={`text-xs font-mono ${saveStatus.cls}`}>{saveStatus.label}</span>
					)}
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
						onClick={() => archiveMutation.mutate()}
						disabled={archiveMutation.isPending}
						className="btn btn-ghost btn-sm text-error font-mono"
					>
						<FiArchive className="w-4 h-4" />
						<span className="hidden sm:inline">Delete</span>
					</button>
					<button
						type="button"
						onClick={() => navigate({ to: '/' })}
						className="btn btn-primary btn-sm font-mono"
					>
						{hasDraft ? 'Draft' : 'Create'}
					</button>
				</>
			}
			value={isLoading ? staleTextRef.current : editorText}
			onChange={isLoading ? () => {} : setEditorText}
			isLoading={isLoading}
			memoryId={id}
			getToken={getToken}
		/>
	)
}
