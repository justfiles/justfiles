import { useMutation } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import React, { useEffect, useState } from 'react'
import {
	FiArchive,
	FiChevronLeft,
	FiFilePlus,
	FiFolder,
	FiRefreshCw,
	FiSearch
} from 'react-icons/fi'
import type { LinkInfo } from '@ghostore/core'
import { applySharedHeaderActionPolicy } from './headerActionPolicy'
import { HeaderActionMenu, type HeaderActionMenuItem } from './HeaderActionMenu'
import { MemoryEditor } from './MemoryEditor'
import { noteFilenameFromPath, noteNameFromPath, notePathWithName } from './notePath'
import { useSidebarActions } from './SidebarContext'
import { useCreateNote } from './useCreateNote'
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
					{items.length} linked {items.length === 1 ? 'file' : 'files'}
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
									onClick={() =>
										navigate({ to: '/files/$id', params: { id: linkedId }, viewTransition: true })
									}
									className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded hover:bg-base-200 transition-colors group"
								>
									<span className="text-base-content/30 font-mono text-xs shrink-0">
										{direction}
									</span>
									<span className="text-sm text-base-content/70 group-hover:text-base-content truncate">
										{link.path
											? noteFilenameFromPath(link.path)
											: (link.title ?? (
													<span className="italic text-base-content/40">Untitled</span>
												))}
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

function FilesBackButton() {
	const navigate = useNavigate()

	return (
		<button
			type="button"
			onClick={() => void navigate({ to: '/files', viewTransition: true })}
			className="btn btn-ghost btn-sm text-primary gap-0.5 -ml-1 sm:hidden"
		>
			<FiChevronLeft className="w-5 h-5" />
			Files
		</button>
	)
}

export function MemoryPage() {
	const { id } = useParams({ strict: false }) as { id: string }
	const navigate = useNavigate()
	const { archiveMemory, reviveMemory } = useVolume()
	const createNote = useCreateNote()
	const {
		memory,
		content,
		saveContent,
		movePath,
		uploadAsset,
		getAssetUrl,
		loadAssetBlob,
		reload,
		isLoading
	} = useMemory(id)
	const { upsertEntry } = useSidebarActions()

	const [nameDraft, setNameDraft] = useState('')

	const renameNoteMutation = useMutation({
		mutationFn: async (rawName: string) => {
			if (!memory?.path) return memory?.path ?? ''
			const nextPath = await movePath(notePathWithName(memory.path, rawName), { dedupe: true })
			return nextPath ?? memory.path
		},
		onSuccess: (path) => {
			const now = new Date().toISOString()
			if (memory) {
				upsertEntry({
					id,
					title: null,
					path,
					updated_at: now,
					tags: memory.tags ?? [],
					active: memory.active ?? 1
				})
			}
			setNameDraft(noteNameFromPath(path))
		}
	})

	const archiveMutation = useMutation({
		mutationFn: async () => archiveMemory(id),
		onSuccess: () => {
			navigate({ to: '/files', viewTransition: true })
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
			return (await movePath(path)) ?? path
		},
		onSuccess: (path) => {
			const now = new Date().toISOString()
			if (memory) {
				upsertEntry({
					id,
					title: null,
					path,
					updated_at: now,
					tags: memory.tags ?? [],
					active: 1
				})
			}
			setNameDraft(noteNameFromPath(path))
		}
	})

	const createNoteMutation = useMutation({
		mutationFn: createNote
	})

	useEffect(() => {
		setNameDraft(memory?.path ? noteNameFromPath(memory.path) : '')
	}, [memory?.path])

	function commitName() {
		if (!memory?.path || memory.active === 0) return
		const currentName = noteNameFromPath(memory.path)
		const trimmed = nameDraft.trim()
		if (trimmed && trimmed !== currentName) {
			renameNoteMutation.mutate(trimmed)
			return
		}
		setNameDraft(currentName)
	}

	function onNameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
		if (e.key === 'Enter') {
			e.preventDefault()
			commitName()
			e.currentTarget.blur()
		} else if (e.key === 'Escape') {
			setNameDraft(memory?.path ? noteNameFromPath(memory.path) : '')
			e.currentTarget.blur()
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
		applySharedHeaderActionPolicy({
			key: 'search',
			label: 'Search',
			onClick: () => window.dispatchEvent(new Event('open-command-palette')),
			icon: <FiSearch className="w-3.5 h-3.5 shrink-0" />,
			shortcut: <kbd className="kbd kbd-xs hidden sm:inline">⌘K</kbd>,
			hideLabelOnMobile: true
		}, 'search', 'editor'),
		...(memory?.active !== 0
			? [
					{
						key: 'move',
						label: 'Move',
						onClick: handleMove,
						disabled: movePathMutation.isPending || !memory,
						icon: <FiFolder className="w-4 h-4" />,
						hideLabelOnMobile: true
					} satisfies HeaderActionMenuItem
				]
			: []),
		// {
		// 	key: 'draft',
		// 	label: 'Draft',
		// 	onClick: () => navigate({ to: '/draft', viewTransition: true }),
		// 	icon: <FiEdit3 className="w-4 h-4" />,
		// 	hideLabelOnMobile: true
		// },
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
		applySharedHeaderActionPolicy({
			key: 'new-note',
			label: 'New file',
			onClick: () => createNoteMutation.mutate(),
			disabled: createNoteMutation.isPending,
			icon: <FiFilePlus className="w-4 h-4" />,
			hideLabelOnMobile: true,
			tone: 'primary'
		}, 'new-file', 'editor')
	]

	return (
		<MemoryEditor
			id={id}
			content={content}
			onSave={saveContent}
			onUploadAsset={uploadAsset}
			resolveAssetUrl={getAssetUrl}
			readAssetBlob={loadAssetBlob}
			isLoading={isLoading}
			readOnly={memory?.active === 0}
			updatedAt={memory?.updated_at}
			leadingControl={<FilesBackButton />}
			headerLeft={
				memory ? (
					<p
						className={`truncate text-sm font-medium ${memory.active === 0 ? 'text-base-content/30 line-through' : 'text-base-content/70'}`}
					>
						{noteFilenameFromPath(memory.path ?? '')}
					</p>
				) : (
					<p className="text-sm text-base-content/40 font-mono">Loading…</p>
				)
			}
			editorHeader={
				memory ? (
					<div className="mb-1">
						<input
							type="text"
							value={nameDraft}
							onChange={(e) => setNameDraft(e.target.value)}
							onBlur={commitName}
							onKeyDown={onNameKeyDown}
							placeholder="untitled"
							readOnly={memory.active === 0}
							className={`block w-full bg-transparent px-0 py-0 text-[1.85rem] leading-tight font-semibold tracking-tight outline-none placeholder:text-base-content/25 ${memory.active === 0 ? 'text-base-content/30 line-through' : 'text-base-content/85'}`}
						/>
					</div>
				) : undefined
			}
			headerRight={<HeaderActionMenu items={headerActions} surface="editor" />}
			footer={memory ? <LinkedMemories links={memory.links} /> : undefined}
		/>
	)
}
