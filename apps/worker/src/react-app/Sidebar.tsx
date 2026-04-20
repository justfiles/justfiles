import { FileTreeView } from '@justfiles/ui'
import { useMutation } from '@tanstack/react-query'
import { useNavigate, useParams, useRouterState } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import { FiEdit3, FiFilePlus, FiFolder, FiSearch, FiX } from 'react-icons/fi'
import { AppHeader } from './AppHeader'
import { normalizeVolumePath } from './assets'
import { HeaderActionMenu, type HeaderActionMenuItem } from './HeaderActionMenu'
import { applySharedHeaderActionPolicy } from './headerActionPolicy'
import { noteFilenameFromPath } from './notePath'
import type { FileMeta } from './types'
import { useCreateNote } from './useCreateNote'
import { useVolume } from './useVolume'

function movePathIntoFolder(entryPath: string, folderPath: string): string {
	return normalizeVolumePath(`${folderPath}/${noteFilenameFromPath(entryPath)}`)
}

type Props = {
	entries: FileMeta[]
	onClose?: () => void
	headerActions?: ReactNode
}

export function Sidebar({ entries, onClose, headerActions }: Props) {
	const params = useParams({ strict: false }) as { id?: string }
	const pathname = useRouterState({ select: (state) => state.location.pathname })
	const navigate = useNavigate()
	const [showArchived, setShowArchived] = useState(false)
	const [organizeMode, setOrganizeMode] = useState(false)
	const createNote = useCreateNote()
	const { moveMemory } = useVolume()
	const isScratchActive = pathname === '/files/scratch'

	const moveMutation = useMutation({
		mutationFn: async ({ id, path }: { id: string; path: string }) =>
			moveMemory(id, path, { dedupe: true }),
		onError: (error) => {
			console.error('Failed to move file from sidebar drag and drop', error)
		}
	})

	const displayEntries = showArchived ? entries : entries.filter((e) => e.active !== 0)
	const fileToolbarItems: HeaderActionMenuItem[] = [
		applySharedHeaderActionPolicy(
			{
				key: 'organize',
				label: organizeMode ? 'Done' : 'Organize',
				onClick: () => setOrganizeMode((value) => !value),
				icon: <FiFolder className="w-3.5 h-3.5" />,
				tone: organizeMode ? 'primary' : 'default',
				hideLabelOnMobile: true
			},
			'organize',
			'sidebar'
		),
		applySharedHeaderActionPolicy(
			{
				key: 'search',
				label: 'Search',
				onClick: () => window.dispatchEvent(new Event('open-command-palette')),
				icon: <FiSearch className="w-3.5 h-3.5 shrink-0" />,
				hideLabelOnMobile: true
			},
			'search',
			'sidebar'
		),
		applySharedHeaderActionPolicy(
			{
				key: 'new-file',
				label: 'New file',
				onClick: () => void createNote(),
				icon: <FiFilePlus className="w-3.5 h-3.5" />,
				tone: 'primary',
				hideLabelOnMobile: true
			},
			'new-file',
			'sidebar'
		)
	]

	return (
		<div className="safe-area-pane flex h-full select-none flex-col">
			<AppHeader
				title={
					<p className="truncate text-sm font-semibold tracking-tight text-base-content/80">
						Files
					</p>
				}
				trailing={
					<>
						<HeaderActionMenu items={fileToolbarItems} surface="sidebar" collapseMode="container" />
						{headerActions}
						{onClose && (
							<button
								type="button"
								onClick={onClose}
								title="Close sidebar"
								className="cursor-pointer rounded-lg p-1.5 text-base-content/40 transition-colors hover:bg-base-200 hover:text-base-content/80"
							>
								<FiX className="h-4 w-4" />
							</button>
						)}
					</>
				}
				secondary={
					<label className="flex w-full cursor-pointer items-center gap-3 text-sm text-base-content/70">
						<input
							type="checkbox"
							className="toggle toggle-sm"
							checked={showArchived}
							onChange={(e) => setShowArchived(e.target.checked)}
						/>
						<span>Show archived</span>
					</label>
				}
			/>
			<div className="no-overscroll flex-1 overflow-y-auto py-2">
				<div className="px-2 pb-2">
					<button
						type="button"
						onClick={() => void navigate({ to: '/files/scratch', viewTransition: true })}
						className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
							isScratchActive
								? 'bg-primary/12 text-primary ring-1 ring-primary/25'
								: 'bg-base-200/70 text-base-content/75 hover:bg-base-200 hover:text-base-content'
						}`}
					>
						<span className={`rounded-lg p-2 ${isScratchActive ? 'bg-primary/12' : 'bg-base-100'}`}>
							<FiEdit3 className="h-4 w-4" />
						</span>
						<span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
							Scratch
						</span>
					</button>
				</div>
				<FileTreeView
					items={displayEntries.map((entry) => ({
						id: entry.id,
						path: entry.path,
						label: noteFilenameFromPath(entry.path),
						muted: entry.active === 0,
						draggable: entry.active !== 0
					}))}
					selectedId={params.id}
					dragEnabled={organizeMode}
					movingItemId={moveMutation.isPending ? (moveMutation.variables?.id ?? null) : null}
					onSelect={(item) =>
						navigate({
							to: '/files/$id',
							params: { id: item.id },
							viewTransition: true
						})
					}
					onMove={({ item, destinationFolderPath }) =>
						moveMutation.mutate({
							id: item.id,
							path: movePathIntoFolder(item.path, destinationFolderPath)
						})
					}
				/>
			</div>
		</div>
	)
}
