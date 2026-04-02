import { useAuth } from '@clerk/clerk-react'
import { useMutation } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import React, { useState } from 'react'
import { FiArchive, FiEdit3, FiFolder, FiRefreshCw, FiSearch } from 'react-icons/fi'
import type { LinkInfo } from '@ghostore/core'
import { HeaderActionMenu, type HeaderActionMenuItem } from './HeaderActionMenu'
import { MemoryEditor } from './MemoryEditor'
import { useSidebarActions } from './SidebarContext'
import { useMemory } from './useMemory'
import { useVolume } from './useVolume'

function LinkedMemories({ links }: { links?: LinkInfo[] }) {
	const navigate = useNavigate()
	const [open, setOpen] = useState(false)
	const items = links ?? []

	if (items.length === 0) return null

	return (
		<div className="mt-6 border-t border-base-200 pt-4">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex items-center gap-2 text-xs text-base-content/40 hover:text-base-content/70 font-mono transition-colors"
			>
				<span>{open ? '▾' : '▸'}</span>
				<span>
					{items.length} linked {items.length === 1 ? 'memory' : 'memories'}
				</span>
			</button>
			{open && (
				<ul className="mt-2 flex flex-col gap-1">
					{items.map((link, i) => {
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
	const { archiveMemory, reviveMemory } = useVolume()
	const { memory, content, saveContent, saveTitle, movePath, reload, isLoading } = useMemory(id)
	const { upsertEntry } = useSidebarActions()

	const [editingTitle, setEditingTitle] = useState(false)
	const [titleDraft, setTitleDraft] = useState('')

	const saveTitleMutation = useMutation({
		mutationFn: async (title: string) => {
			await saveTitle(title || null)
			return title
		},
		onSuccess: (title) => {
			const now = new Date().toISOString()
			if (memory) {
				upsertEntry({
					id: id,
					title: title || null,
					path: memory.path ?? '',
					updated_at: now,
					tags: memory.tags ?? [],
					active: memory.active ?? 1
				})
			}
		}
	})

	const archiveMutation = useMutation({
		mutationFn: async () => archiveMemory(id),
		onSuccess: () => {
			navigate({ to: '/' })
		}
	})

	const reviveMutation = useMutation({
		mutationFn: async () => reviveMemory(id),
		onSuccess: () => {
			void reload()
		}
	})

	const movePathMutation = useMutation({
		mutationFn: async (path: string) => {
			await movePath(path)
			return path
		},
		onSuccess: (path) => {
			const now = new Date().toISOString()
			if (memory) {
				upsertEntry({
					id,
					title: memory.title ?? null,
					path,
					updated_at: now,
					tags: memory.tags ?? [],
					active: 1
				})
			}
		}
	})

	function startEditingTitle() {
		setTitleDraft(memory?.title ?? '')
		setEditingTitle(true)
	}

	function commitTitle() {
		setEditingTitle(false)
		const trimmed = titleDraft.trim()
		if (trimmed !== (memory?.title ?? '')) {
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
		const currentPath = memory?.path ?? ''
		const newPath = window.prompt('Enter new path:', currentPath)
		if (newPath !== null && newPath.trim() !== '' && newPath.trim() !== currentPath) {
			movePathMutation.mutate(newPath.trim())
		}
	}

	const headerActions: HeaderActionMenuItem[] = [
		{
			key: 'search',
			label: 'Search',
			onClick: () => window.dispatchEvent(new Event('open-command-palette')),
			icon: <FiSearch className="w-3.5 h-3.5 shrink-0" />,
			shortcut: <kbd className="kbd kbd-xs hidden sm:inline">⌘K</kbd>,
			hideLabelOnMobile: true
		},
		...(memory?.active !== 0
			? [{
				key: 'move',
				label: 'Move',
				onClick: handleMove,
				disabled: movePathMutation.isPending || !memory,
				icon: <FiFolder className="w-4 h-4" />,
				hideLabelOnMobile: true
			} satisfies HeaderActionMenuItem]
			: []),
		(memory?.active === 0
			? {
				key: 'revive',
				label: 'Revive',
				onClick: () => reviveMutation.mutate(),
				disabled: reviveMutation.isPending,
				icon: <FiRefreshCw className="w-4 h-4" />,
				hideLabelOnMobile: true,
				tone: 'success'
			}
			: {
				key: 'delete',
				label: 'Delete',
				onClick: () => archiveMutation.mutate(),
				disabled: archiveMutation.isPending,
				icon: <FiArchive className="w-4 h-4" />,
				hideLabelOnMobile: true,
				tone: 'danger'
			}) satisfies HeaderActionMenuItem,
		{
			key: 'create',
			label: 'Create',
			onClick: () => navigate({ to: '/' }),
			icon: <FiEdit3 className="w-4 h-4" />,
			hideLabelOnMobile: true,
			tone: 'primary'
		}
	]

	return (
		<MemoryEditor
			id={id}
			assetOwnerId={id}
			content={content}
			onSave={saveContent}
			isLoading={isLoading}
			readOnly={memory?.active === 0}
			getToken={getToken}
			updatedAt={memory?.updated_at}
			headerLeft={
				memory ? (
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
							className={`block w-full text-left text-sm font-medium truncate transition-colors cursor-text ${memory.active === 0 ? 'text-base-content/30 line-through hover:text-base-content/50' : 'text-base-content/70 hover:text-base-content'}`}
						>
							{memory.title ?? <span className="italic">Untitled</span>}
						</button>
					)
				) : (
					<p className="text-sm text-base-content/40 font-mono">Loading…</p>
				)
			}
			headerRight={
				<HeaderActionMenu items={headerActions} />
			}
			footer={memory ? <LinkedMemories links={memory.links} /> : undefined}
		/>
	)
}
