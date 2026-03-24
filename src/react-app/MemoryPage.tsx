import { useAuth } from '@clerk/clerk-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import React, { useState } from 'react'
import { FiArchive, FiEdit3, FiFolder, FiRefreshCw, FiSearch } from 'react-icons/fi'
import type { LinkInfo, Memory } from '../core/store'
import { MemoryEditor } from './MemoryEditor'
import { useSidebarActions } from './SidebarContext'
import { useSync } from './sync'
import { useApiClient } from './useApiClient'

function LinkedMemories({ links }: { links: LinkInfo[] }) {
	const navigate = useNavigate()
	const [open, setOpen] = useState(false)

	if (links.length === 0) return null

	return (
		<div className="mt-6 border-t border-base-200 pt-4">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex items-center gap-2 text-xs text-base-content/40 hover:text-base-content/70 font-mono transition-colors"
			>
				<span>{open ? '▾' : '▸'}</span>
				<span>
					{links.length} linked {links.length === 1 ? 'memory' : 'memories'}
				</span>
			</button>
			{open && (
				<ul className="mt-2 flex flex-col gap-1">
					{links.map((link, i) => {
						const linkedId = link.to_id ?? link.from_id!
						const direction = link.to_id ? '→' : '←'
						return (
							<li key={i}>
								<button
									type="button"
									onClick={() => navigate({ to: '/memory/$id', params: { id: linkedId } })}
									className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded hover:bg-base-200 transition-colors group"
								>
									<span className="text-base-content/30 font-mono text-xs shrink-0">
										{direction}
									</span>
									<span className="text-sm text-base-content/70 group-hover:text-base-content truncate">
										{link.title ?? <span className="italic text-base-content/40">Untitled</span>}
									</span>
									<span className="text-xs text-base-content/30 font-mono shrink-0 ml-auto">
										{link.rel_type}
									</span>
								</button>
								{link.reason && (
									<p className="ml-6 text-xs text-base-content/30 font-mono px-2">{link.reason}</p>
								)}
							</li>
						)
					})}
				</ul>
			)}
		</div>
	)
}

export function MemoryPage() {
	const { id } = useParams({ strict: false }) as { id: string }
	const navigate = useNavigate()
	const { getToken } = useAuth()
	const api = useApiClient()
	const sync = useSync()
	const { upsertEntry, removeEntry } = useSidebarActions()
	const queryClient = useQueryClient()

	const [editingTitle, setEditingTitle] = useState(false)
	const [titleDraft, setTitleDraft] = useState('')

	const memoryQuery = useQuery({
		queryKey: ['memory', id],
		queryFn: async () => {
			const res = await api.v1.memory[':id'].$get({ param: { id } })
			if (!res.ok) throw new Error(`Failed: ${res.status}`)
			return res.json() as Promise<Memory>
		}
	})

	const saveTitleMutation = useMutation({
		mutationFn: async (title: string) => {
			await sync.push(id, { title: title || null }, true)
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
			queryClient.setQueryData<Memory>(['memory', id], (old) => (old ? { ...old, active: 1 } : old))
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
			await sync.push(id, { path }, true)
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

	function startEditingTitle() {
		setTitleDraft(memoryQuery.data?.title ?? '')
		setEditingTitle(true)
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

	function handleMove() {
		const currentPath = memoryQuery.data?.path ?? ''
		const newPath = window.prompt('Enter new path:', currentPath)
		if (newPath !== null && newPath.trim() !== '' && newPath.trim() !== currentPath) {
			movePathMutation.mutate(newPath.trim())
		}
	}

	if (memoryQuery.isError) return <p className="m-8 text-error">Failed to load memory</p>

	return (
		<MemoryEditor
			id={id}
			isLoading={memoryQuery.isPending}
			readOnly={memoryQuery.data?.active === 0}
			getToken={getToken}
			updatedAt={memoryQuery.data?.updated_at}
			headerLeft={
				memoryQuery.data ? (
					editingTitle ? (
						<input
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
							{memoryQuery.data.title ?? <span className="italic">Untitled</span>}
						</button>
					)
				) : (
					<p className="text-sm text-base-content/40 font-mono">Loading…</p>
				)
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
						<FiEdit3 className="w-4 h-4" />
						<span className="hidden sm:inline">Create</span>
					</button>
				</>
			}
			footer={memoryQuery.data ? <LinkedMemories links={memoryQuery.data.links} /> : undefined}
		/>
	)
}
