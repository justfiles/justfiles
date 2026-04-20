import { DragDropProvider, DragOverlay, useDraggable, useDroppable } from '@dnd-kit/react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { FiChevronDown, FiChevronRight, FiFile } from 'react-icons/fi'
import { LuGripVertical } from 'react-icons/lu'

export type FileTreeItem = {
	id: string
	path: string
	label?: string
	disabled?: boolean
	muted?: boolean
	draggable?: boolean
}

type InternalTreeNode = {
	name: string
	fullPath: string
	children: Map<string, InternalTreeNode>
	items: FileTreeItem[]
}

type TreeNode = {
	name: string
	fullPath: string
	children: TreeNode[]
	items: FileTreeItem[]
}

export type FileTreeViewProps = {
	items: FileTreeItem[]
	selectedId?: string
	emptyState?: ReactNode
	dragEnabled?: boolean
	movingItemId?: string | null
	rootDropLabel?: string
	onSelect?: (item: FileTreeItem) => void
	onMove?: (args: { item: FileTreeItem; destinationFolderPath: string }) => void
}

type FileDragData = {
	kind: 'file'
	itemId: string
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

type TreeDragData = FileDragData | FolderDropData | RootDropData

function itemName(item: FileTreeItem): string {
	if (item.label) return item.label
	const parts = item.path.split('/').filter(Boolean)
	return parts[parts.length - 1] ?? item.path
}

function buildTree(items: FileTreeItem[]): TreeNode {
	const root: InternalTreeNode = {
		name: '',
		fullPath: '/',
		children: new Map(),
		items: []
	}

	for (const item of items) {
		const parts = item.path.split('/').filter(Boolean)
		let node = root
		let fullPath = ''
		for (const part of parts.slice(0, -1)) {
			fullPath = `${fullPath}/${part}`
			let next = node.children.get(part)
			if (!next) {
				next = {
					name: part,
					fullPath,
					children: new Map(),
					items: []
				}
				node.children.set(part, next)
			}
			node = next
		}
		node.items.push(item)
	}

	const finalize = (node: InternalTreeNode): TreeNode => ({
		name: node.name,
		fullPath: node.fullPath,
		items: [...node.items].sort((left, right) => itemName(left).localeCompare(itemName(right))),
		children: [...node.children.values()]
			.map((child) => finalize(child))
			.sort((left, right) => left.name.localeCompare(right.name))
	})

	return finalize(root)
}

type FolderNodeProps = {
	node: TreeNode
	depth: number
	selectedId?: string
	dragEnabled: boolean
	draggingItemId: string | null
	movingItemId: string | null
	onSelect?: (item: FileTreeItem) => void
	onMove?: (args: { item: FileTreeItem; destinationFolderPath: string }) => void
}

type FileNodeProps = {
	item: FileTreeItem
	depth: number
	selectedId?: string
	dragEnabled: boolean
	movingItemId: string | null
	onSelect?: (item: FileTreeItem) => void
}

function FileNode({ item, depth, selectedId, dragEnabled, movingItemId, onSelect }: FileNodeProps) {
	const dragDisabled =
		!dragEnabled || item.draggable === false || item.disabled || movingItemId === item.id
	const { ref, handleRef, isDragging } = useDraggable<TreeDragData>({
		id: `file:${item.id}`,
		data: {
			kind: 'file',
			itemId: item.id,
			path: item.path
		},
		disabled: dragDisabled,
		feedback: 'move'
	})

	return (
		<div
			ref={ref}
			style={{ paddingLeft: `${depth * 12 + 8}px` }}
			className={`flex w-full items-start gap-1 rounded transition-opacity ${
				isDragging ? 'opacity-40' : ''
			}`}
		>
			<button
				type="button"
				onClick={() => onSelect?.(item)}
				disabled={item.disabled || movingItemId === item.id}
				className={`flex min-w-0 flex-1 items-start gap-1.5 rounded px-2 py-1 font-mono transition-colors ${
					selectedId === item.id
						? 'bg-primary/15 text-primary'
						: item.muted
							? 'text-base-content/30 hover:bg-base-200 hover:text-base-content/50'
							: 'text-base-content/70 hover:bg-base-200 hover:text-base-content'
				} ${movingItemId === item.id ? 'cursor-progress' : 'cursor-pointer'}`}
			>
				<FiFile className="mt-0.5 h-3 w-3 shrink-0 opacity-50" />
				<span
					className={`truncate text-left text-xs leading-snug ${item.muted ? 'line-through' : ''}`}
				>
					{itemName(item)}
				</span>
			</button>
			{dragEnabled ? (
				<button
					ref={handleRef}
					type="button"
					disabled={dragDisabled}
					title="Drag to move"
					aria-label={`Drag ${itemName(item)}`}
					className="mt-0.5 cursor-grab rounded p-1 text-base-content/25 transition-colors hover:bg-base-200 hover:text-base-content/55 active:cursor-grabbing disabled:cursor-default disabled:opacity-20"
				>
					<LuGripVertical className="h-3.5 w-3.5" />
				</button>
			) : null}
		</div>
	)
}

function FolderNode({
	node,
	depth,
	selectedId,
	dragEnabled,
	draggingItemId,
	movingItemId,
	onSelect,
	onMove
}: FolderNodeProps) {
	const [open, setOpen] = useState(true)
	const hasChildren = node.children.length > 0 || node.items.length > 0
	const { ref, isDropTarget } = useDroppable<TreeDragData>({
		id: `folder:${node.fullPath}`,
		data: {
			kind: 'folder',
			path: node.fullPath
		},
		disabled: !node.name || !onMove || !dragEnabled || draggingItemId === null
	})

	useEffect(() => {
		if (!node.name || open || !isDropTarget || !hasChildren) return
		const timer = window.setTimeout(() => setOpen(true), 400)
		return () => window.clearTimeout(timer)
	}, [hasChildren, isDropTarget, node.name, open])

	if (node.name && !hasChildren) return null

	return (
		<div
			ref={node.name ? ref : undefined}
			className={
				node.name && isDropTarget ? 'rounded bg-primary/8 ring-1 ring-primary/20' : undefined
			}
		>
			{node.name ? (
				<button
					type="button"
					onClick={() => setOpen((value) => !value)}
					style={{ paddingLeft: `${depth * 12}px` }}
					className={`flex w-full cursor-pointer items-center gap-1 rounded px-2 py-0.5 font-mono text-xs transition-colors ${
						isDropTarget
							? 'bg-primary/12 text-primary ring-1 ring-primary/30'
							: 'text-base-content/50 hover:bg-base-200 hover:text-base-content/80'
					}`}
				>
					{hasChildren ? (
						open ? (
							<FiChevronDown className="h-3 w-3 shrink-0" />
						) : (
							<FiChevronRight className="h-3 w-3 shrink-0" />
						)
					) : (
						<span className="w-3" />
					)}
					<span className="truncate">{node.name}</span>
				</button>
			) : null}
			{open || !node.name ? (
				<>
					{node.children.map((child) => (
						<FolderNode
							key={child.fullPath}
							node={child}
							depth={node.name ? depth + 1 : depth}
							selectedId={selectedId}
							dragEnabled={dragEnabled}
							draggingItemId={draggingItemId}
							movingItemId={movingItemId}
							onSelect={onSelect}
							onMove={onMove}
						/>
					))}
					{node.items.map((item) => {
						return (
							<FileNode
								key={item.id}
								item={item}
								depth={node.name ? depth + 1 : depth}
								selectedId={selectedId}
								dragEnabled={dragEnabled}
								movingItemId={movingItemId}
								onSelect={onSelect}
							/>
						)
					})}
				</>
			) : null}
		</div>
	)
}

function RootDropTarget({ active, label }: { active: boolean; label: string }) {
	const { ref, isDropTarget } = useDroppable<TreeDragData>({
		id: 'root-drop',
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
				className={`rounded border border-dashed px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors ${
					isDropTarget
						? 'border-primary/50 bg-primary/10 text-primary'
						: 'border-base-300 text-base-content/35'
				}`}
			>
				{label}
			</div>
		</div>
	)
}

export function FileTreeView({
	items,
	selectedId,
	emptyState = <p className="px-3 py-2 font-mono text-xs text-base-content/30">No files yet</p>,
	dragEnabled = false,
	movingItemId = null,
	rootDropLabel = 'Drop here to move to root',
	onSelect,
	onMove
}: FileTreeViewProps) {
	const tree = useMemo(() => buildTree(items), [items])
	const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
	const [draggedItem, setDraggedItem] = useState<FileTreeItem | null>(null)

	if (items.length === 0) return <>{emptyState}</>

	if (!dragEnabled || !onMove) {
		return (
			<FolderNode
				node={tree}
				depth={0}
				selectedId={selectedId}
				dragEnabled={false}
				draggingItemId={null}
				movingItemId={movingItemId}
				onSelect={onSelect}
			/>
		)
	}

	return (
		<DragDropProvider
			onDragStart={({ operation }: any) => {
				const source = operation.source?.data as FileDragData | undefined
				if (source?.kind !== 'file') return
				setDraggedItem(itemsById.get(source.itemId) ?? null)
			}}
			onDragEnd={({ canceled, operation }: any) => {
				const source = operation.source?.data as FileDragData | undefined
				const target = operation.target?.data as FolderDropData | RootDropData | undefined
				setDraggedItem(null)
				if (canceled || source?.kind !== 'file' || !target) return

				const item = itemsById.get(source.itemId)
				if (!item) return
				onMove({ item, destinationFolderPath: target.path })
			}}
		>
			<>
				<RootDropTarget active={draggedItem !== null} label={rootDropLabel} />
				<FolderNode
					node={tree}
					depth={0}
					selectedId={selectedId}
					dragEnabled
					draggingItemId={draggedItem?.id ?? null}
					movingItemId={movingItemId}
					onSelect={onSelect}
					onMove={onMove}
				/>
				<DragOverlay className="pointer-events-none" dropAnimation={null}>
					{draggedItem ? (
						<div className="rounded border border-base-300 bg-base-100 px-3 py-1.5 font-mono text-xs text-base-content/80 shadow-lg">
							{itemName(draggedItem)}
						</div>
					) : null}
				</DragOverlay>
			</>
		</DragDropProvider>
	)
}
