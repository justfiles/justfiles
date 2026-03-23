import { useAuth } from '@clerk/clerk-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import React, { useEffect, useRef, useState } from 'react'
import { FiArchive, FiFolder, FiRefreshCw, FiSearch } from 'react-icons/fi'
import type { Memory } from '../core/store'
import { EditorLayout } from './EditorLayout'
import { useSidebarActions } from './SidebarContext'
import { useApiClient } from './useApiClient'

export function MemoryPage() {
	const { id } = useParams({ strict: false }) as { id: string }
	const navigate = useNavigate()
	const { getToken, userId } = useAuth()
	const api = useApiClient()
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
			const res = await api.v1.memory[':id'].$get({ param: { id } })
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
			const res = await api.v1.update.$post({ json: { id: memoryQuery.data!.id, content: text } })
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
					tags: memoryQuery.data.tags,
					active: memoryQuery.data.active
				})
			}
		}
	})

	const saveTitleMutation = useMutation({
		mutationFn: async (title: string) => {
			const res = await api.v1.update.$post({ json: { id: memoryQuery.data!.id, title: title || undefined } })
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
					tags: memoryQuery.data.tags,
					active: memoryQuery.data.active
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
			const res = await api.v1.memory[':id'].archive.$post({ param: { id } })
			if (!res.ok) throw new Error(`Archive failed: ${res.status}`)
		},
		onSuccess: () => {
			removeEntry(id)
			navigate({ to: '/' })
		}
	})

	const reviveMutation = useMutation({
		mutationFn: async () => {
			const res = await api.v1.memory[':id'].revive.$post({ param: { id } })
			if (!res.ok) throw new Error(`Revive failed: ${res.status}`)
		},
		onSuccess: () => {
			queryClient.setQueryData<Memory>(['memory', id], (old) => old ? { ...old, active: 1 } : old)
			if (memoryQuery.data) {
				upsertEntry({
					id: memoryQuery.data.id,
					title: memoryQuery.data.title,
					path: memoryQuery.data.path,
					updated_at: memoryQuery.data.updated_at,
					tags: memoryQuery.data.tags,
					active: 1
				})
			}
		}
	})

	const movePathMutation = useMutation({
		mutationFn: async (path: string) => {
			const res = await api.v1.update.$post({ json: { id: memoryQuery.data!.id, path } })
			if (!res.ok) throw new Error(`Move failed: ${res.status}`)
			return path
		},
		onSuccess: (path) => {
			const now = new Date().toISOString()
			queryClient.setQueryData<Memory>(['memory', id], (old) =>
				old ? { ...old, path, updated_at: now } : old
			)
			if (memoryQuery.data) {
				upsertEntry({
					id: memoryQuery.data.id,
					title: memoryQuery.data.title,
					path,
					updated_at: now,
					tags: memoryQuery.data.tags,
					active: 1
				})
			}
		}
	})

	function handleMove() {
		const currentPath = memoryQuery.data?.path ?? ''
		const newPath = window.prompt('Enter new path:', currentPath)
		if (newPath !== null && newPath.trim() !== '' && newPath.trim() !== currentPath) {
			movePathMutation.mutate(newPath.trim())
		}
	}

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
							className={`block w-full text-left text-sm font-medium truncate transition-colors cursor-text ${memoryQuery.data.active === 0 ? 'text-base-content/30 line-through hover:text-base-content/50' : 'text-base-content/70 hover:text-base-content'}`}
						>
							{memoryQuery.data.title ?? <span className="italic">Untitled</span>}{hasPendingTimer || saveMutation.isPending ? '*' : ''}
						</button>
					)
				) : undefined
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
					{memoryQuery.data?.active !== 0 && (
						<button
							type="button"
							onClick={handleMove}
							disabled={movePathMutation.isPending || !memoryQuery.data}
							className="btn btn-ghost btn-sm font-mono"
						>
							<FiFolder className="w-4 h-4" />
							<span className="hidden sm:inline">Move</span>
						</button>
					)}
					{memoryQuery.data?.active === 0 ? (
						<button
							type="button"
							onClick={() => reviveMutation.mutate()}
							disabled={reviveMutation.isPending}
							className="btn btn-ghost btn-sm text-success font-mono"
						>
							<FiRefreshCw className="w-4 h-4" />
							<span className="hidden sm:inline">Revive</span>
						</button>
					) : (
						<button
							type="button"
							onClick={() => archiveMutation.mutate()}
							disabled={archiveMutation.isPending}
							className="btn btn-ghost btn-sm text-error font-mono"
						>
							<FiArchive className="w-4 h-4" />
							<span className="hidden sm:inline">Delete</span>
						</button>
					)}
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
			readOnly={memoryQuery.data?.active === 0}
			memoryId={id}
			getToken={getToken}
			updatedAt={memoryQuery.data?.updated_at}
		/>
	)
}
