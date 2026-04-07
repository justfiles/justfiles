import { useMutation } from '@tanstack/react-query'
import {
	DragDropProvider,
	DragOverlay,
	useDraggable,
	useDroppable
} from '@dnd-kit/react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { MemoryMeta } from '@ghostore/core'
import { FiChevronDown, FiChevronRight, FiFile, FiFilePlus, FiMove, FiX } from 'react-icons/fi'
import { LuGripVertical } from 'react-icons/lu'
import { normalizeVolumePath } from './assets'
import { noteFilenameFromPath } from './notePath'
import { useCreateNote } from './useCreateNote'
import { useVolume } from './useVolume'

const ROOT_DROP_ID = 'root-drop'

type FileDragData = {
	kind: 'file'
	entryId: string
	path: string
}

type FolderDropData = {
	kind: 'folder'
	path: string
}

type RootDropData = {
	kind: 'root'
	path: '/'
}

type SidebarDragData = FileDragData | FolderDropData | RootDropData

type TreeNode = {
	name: string
	fullPath: string
	children: Map<string, TreeNode>
	entries: MemoryMeta[]
}

function buildTree(entries: MemoryMeta[]): TreeNode {
	const root: TreeNode = { name: '', fullPath: '', children: new Map(), entries: [] }
	for (const entry of entries) {
		const parts = entry.path.split('/').filter(Boolean)
		let node = root
		let cumPath = ''
		for (let i = 0; i < parts.length - 1; i++) {
			cumPath = cumPath ? `${cumPath}/${parts[i]}` : parts[i]
			if (!node.children.has(parts[i])) {
				node.children.set(parts[i], { name: parts[i], fullPath: cumPath, children: new Map(), entries: [] })
			}
			node = node.children.get(parts[i])!
		}
		node.entries.push(entry)
	}
	return root
}

type FolderNodeProps = {
	key?: string
	node: TreeNode
	depth: number
	activeId: string | undefined
	showArchived: boolean
	dragEnabled: boolean
	draggingEntryId: string | null
	movingEntryId: string | null
}

type FileNodeProps = {
	entry: MemoryMeta
	depth: number
	activeId: string | undefined
	movingEntryId: string | null
	dragEnabled: boolean
}

function movePathIntoFolder(entryPath: string, folderPath: string): string {
	return normalizeVolumePath(`${folderPath}/${noteFilenameFromPath(entryPath)}`)
}

function FileNode({ entry, depth, activeId, movingEntryId, dragEnabled }: FileNodeProps) {
	const navigate = useNavigate()
	const isArchived = entry.active === 0
	const dragDisabled = !dragEnabled || isArchived || movingEntryId === entry.id
	const { ref, handleRef, isDragging } = useDraggable<SidebarDragData>({
		id: `file:${entry.id}`,
		data: {
			kind: 'file',
			entryId: entry.id,
			path: entry.path
		},
		disabled: dragDisabled,
		feedback: 'move'
	})

	return (
		<div
			ref={ref}
			style={{ paddingLeft: `${depth * 12 + 8}px` }}
			className={`flex items-start gap-1 w-full rounded transition-opacity ${
				isDragging ? 'opacity-40' : ''
			}`}
		>
			<button
				type="button"
				onClick={() => navigate({ to: '/memory/$id', params: { id: entry.id } })}
				disabled={movingEntryId === entry.id}
				className={`flex items-start gap-1.5 min-w-0 flex-1 px-2 py-1 rounded transition-colors font-mono ${
					activeId === entry.id
						? 'bg-primary/15 text-primary'
						: isArchived
							? 'text-base-content/30 hover:text-base-content/50 hover:bg-base-200'
							: 'text-base-content/70 hover:text-base-content hover:bg-base-200'
				} ${movingEntryId === entry.id ? 'cursor-progress' : 'cursor-pointer'}`}
			>
				<FiFile className="w-3 h-3 shrink-0 opacity-50 mt-0.5" />
				<span className={`truncate text-xs leading-snug text-left ${isArchived ? 'line-through' : ''}`}>
					{noteFilenameFromPath(entry.path)}
				</span>
			</button>
			{dragEnabled && (
				<button
					ref={handleRef}
					type="button"
					disabled={dragDisabled}
					title="Drag to move"
					aria-label={`Drag ${noteFilenameFromPath(entry.path)}`}
					className="touch-none mt-0.5 p-1 rounded text-base-content/25 hover:text-base-content/55 hover:bg-base-200 disabled:opacity-20 disabled:cursor-default cursor-grab active:cursor-grabbing transition-colors"
				>
					<LuGripVertical className="w-3.5 h-3.5" />
				</button>
			)}
		</div>
	)
}

function hasVisibleItems(node: TreeNode, showArchived: boolean): boolean {
	const visibleEntries = node.entries.filter((e) => showArchived || e.active !== 0)
	if (visibleEntries.length > 0) return true
	return [...node.children.values()].some((child) => hasVisibleItems(child, showArchived))
}

function FolderNode({ node, depth, activeId, showArchived, dragEnabled, draggingEntryId, movingEntryId }: FolderNodeProps) {
	const [open, setOpen] = useState(true)
	const { ref, isDropTarget } = useDroppable<SidebarDragData>({
		id: `folder:${node.fullPath}`,
		data: {
			kind: 'folder',
			path: node.fullPath
		},
		disabled: !node.name || draggingEntryId === null
	})

	const visibleEntries = node.entries.filter((e) => showArchived || e.active !== 0)
	const hasChildren = visibleEntries.length > 0 || [...node.children.values()].some((child) => hasVisibleItems(child, showArchived))

	useEffect(() => {
		if (!node.name || open || !isDropTarget || !hasChildren) return
		const timer = window.setTimeout(() => setOpen(true), 400)
		return () => window.clearTimeout(timer)
	}, [hasChildren, isDropTarget, node.name, open])

	if (node.name && !hasChildren) return null

	return (
		<div
			ref={node.name ? ref : undefined}
			className={node.name && isDropTarget ? 'rounded bg-primary/8 ring-1 ring-primary/20' : undefined}
		>
			{node.name && (
				<button
					type="button"
					onClick={() => setOpen((o: boolean) => !o)}
					style={{ paddingLeft: `${depth * 12}px` }}
					className={`flex items-center gap-1 w-full px-2 py-0.5 text-xs rounded transition-colors cursor-pointer font-mono ${
						isDropTarget
							? 'bg-primary/12 text-primary ring-1 ring-primary/30'
							: 'text-base-content/50 hover:text-base-content/80 hover:bg-base-200'
					}`}
				>
					{hasChildren ? (
						open ? <FiChevronDown className="w-3 h-3 shrink-0" /> : <FiChevronRight className="w-3 h-3 shrink-0" />
					) : (
						<span className="w-3" />
					)}
					<span className="truncate">{node.name}</span>
				</button>
			)}
			{(open || !node.name) && (
				<>
					{[...node.children.values()].map((child) => (
						<FolderNode
							key={child.fullPath}
							node={child}
							depth={node.name ? depth + 1 : depth}
							activeId={activeId}
							showArchived={showArchived}
							dragEnabled={dragEnabled}
							draggingEntryId={draggingEntryId}
							movingEntryId={movingEntryId}
						/>
					))}
					{visibleEntries.map((entry) => (
						<FileNode
							key={entry.id}
							entry={entry}
							depth={(node.name ? depth + 1 : depth)}
							activeId={activeId}
							movingEntryId={movingEntryId}
							dragEnabled={dragEnabled}
						/>
					))}
				</>
			)}
		</div>
	)
}

function RootDropTarget({ active }: { active: boolean }) {
	const { ref, isDropTarget } = useDroppable<SidebarDragData>({
		id: ROOT_DROP_ID,
		data: {
			kind: 'root',
			path: '/'
		},
		disabled: !active
	})

	if (!active) return null

	return (
		<div className="px-3 pb-2">
			<div
				ref={ref}
				className={`rounded border border-dashed px-2 py-1 text-[10px] font-mono uppercase tracking-wider transition-colors ${
					isDropTarget
						? 'border-primary/50 bg-primary/10 text-primary'
						: 'border-base-300 text-base-content/35'
				}`}
			>
				Drop here to move to root
			</div>
		</div>
	)
}

type Props = {
	entries: MemoryMeta[]
	onClose: () => void
}

export function Sidebar({ entries, onClose }: Props) {
	const params = useParams({ strict: false }) as { id?: string }
	const [showArchived, setShowArchived] = useState(false)
	const [organizeMode, setOrganizeMode] = useState(false)
	const [draggedEntry, setDraggedEntry] = useState<MemoryMeta | null>(null)
	const createNote = useCreateNote()
	const { moveMemory } = useVolume()

	const moveMutation = useMutation({
		mutationFn: async ({ id, path }: { id: string; path: string }) => moveMemory(id, path, { dedupe: true }),
		onError: (error) => {
			console.error('Failed to move note from sidebar drag and drop', error)
		}
	})

	const displayEntries = showArchived ? entries : entries.filter((e) => e.active !== 0)
	const tree = buildTree(entries)

	return (
		<DragDropProvider
			onDragStart={({ operation }) => {
				const source = operation.source?.data as FileDragData | undefined
				if (source?.kind !== 'file') return
				const entry = entries.find((candidate) => candidate.id === source.entryId) ?? null
				setDraggedEntry(entry)
			}}
			onDragEnd={({ canceled, operation }) => {
				const source = operation.source?.data as FileDragData | undefined
				const target = operation.target?.data as FolderDropData | RootDropData | undefined

				setDraggedEntry(null)
				if (canceled || source?.kind !== 'file' || !target) return

				const nextPath = movePathIntoFolder(source.path, target.path)
				moveMutation.mutate({
					id: source.entryId,
					path: nextPath
				})
			}}
		>
			<div className="safe-area-sidebar flex flex-col h-full select-none">
				<div className="flex items-center justify-between px-3 py-2 shrink-0 border-b border-base-300">
					<span className="text-xs font-semibold font-mono text-base-content/50 uppercase tracking-wider">
						Memories
					</span>
					<button
						type="button"
						onClick={onClose}
						title="Close sidebar"
						className="p-1 rounded hover:bg-base-300 text-base-content/40 hover:text-base-content/80 transition-colors cursor-pointer"
					>
						<FiX className="w-3.5 h-3.5" />
					</button>
				</div>
				<div className="flex items-center gap-2 px-3 py-1.5 shrink-0 border-b border-base-300">
					<button
						type="button"
						onClick={() => void createNote()}
						className="btn btn-xs btn-primary gap-1.5 font-mono"
					>
						<FiFilePlus className="w-3 h-3" />
						New note
					</button>
					<button
						type="button"
						onClick={() => setOrganizeMode((value) => !value)}
						className={`btn btn-xs gap-1.5 font-mono ${organizeMode ? 'btn-secondary' : 'btn-ghost'}`}
					>
						<FiMove className="w-3 h-3" />
						{organizeMode ? 'Done' : 'Organize'}
					</button>
					<label className="flex items-center gap-2 cursor-pointer">
						<input
							type="checkbox"
							className="toggle toggle-xs"
							checked={showArchived}
							onChange={(e) => setShowArchived(e.target.checked)}
						/>
						<span className="text-[10px] font-mono text-base-content/40 uppercase tracking-wider">Show deleted</span>
					</label>
				</div>
				<div className="no-overscroll flex-1 overflow-y-auto py-2">
					<RootDropTarget active={draggedEntry !== null} />
					{displayEntries.length === 0 ? (
						<p className="px-3 py-2 text-xs text-base-content/30 font-mono">No memories yet</p>
					) : (
					<FolderNode
						node={tree}
						depth={0}
						activeId={params.id}
						showArchived={showArchived}
						dragEnabled={organizeMode}
						draggingEntryId={draggedEntry?.id ?? null}
						movingEntryId={moveMutation.isPending ? moveMutation.variables?.id ?? null : null}
					/>
				)}
			</div>
			</div>
			<DragOverlay className="pointer-events-none" dropAnimation={null}>
				{draggedEntry ? (
					<div className="rounded border border-base-300 bg-base-100 px-3 py-1.5 shadow-lg font-mono text-xs text-base-content/80">
						{noteFilenameFromPath(draggedEntry.path)}
					</div>
				) : null}
			</DragOverlay>
		</DragDropProvider>
	)
}
