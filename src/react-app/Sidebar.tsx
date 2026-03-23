import { useNavigate, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { FiChevronDown, FiChevronRight, FiFile, FiX } from 'react-icons/fi'
import type { MemoryMeta } from './useSidebar'

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
}

function FolderNode({ node, depth, activeId, showArchived }: FolderNodeProps) {
	const [open, setOpen] = useState(true)
	const navigate = useNavigate()

	const visibleEntries = node.entries.filter((e) => showArchived || e.active !== 0)
	const hasChildren = node.children.size > 0 || visibleEntries.length > 0

	return (
		<div>
			{node.name && (
				<button
					type="button"
					onClick={() => setOpen((o: boolean) => !o)}
					style={{ paddingLeft: `${depth * 12}px` }}
					className="flex items-center gap-1 w-full px-2 py-0.5 text-xs text-base-content/50 hover:text-base-content/80 hover:bg-base-200 rounded transition-colors cursor-pointer font-mono"
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
						<FolderNode key={child.fullPath} node={child} depth={node.name ? depth + 1 : depth} activeId={activeId} showArchived={showArchived} />
					))}
					{visibleEntries.map((entry) => {
						const isArchived = entry.active === 0
						return (
							<button
								key={entry.id}
								type="button"
								onClick={() => navigate({ to: '/memory/$id', params: { id: entry.id } })}
								style={{ paddingLeft: `${(node.name ? depth + 1 : depth) * 12 + 16}px` }}
								className={`flex items-start gap-1.5 w-full px-2 py-1 rounded transition-colors cursor-pointer font-mono ${
									activeId === entry.id
										? 'bg-primary/15 text-primary'
										: isArchived
											? 'text-base-content/30 hover:text-base-content/50 hover:bg-base-200'
											: 'text-base-content/70 hover:text-base-content hover:bg-base-200'
								}`}
							>
								<FiFile className="w-3 h-3 shrink-0 opacity-50 mt-0.5" />
								<span className="flex flex-col min-w-0">
									<span className="truncate text-[10px] opacity-40 leading-tight text-left">{entry.path.split('/').slice(-1)[0]}</span>
									<span className={`truncate text-xs leading-snug ${isArchived ? 'line-through' : ''}`}>{entry.title ?? entry.path.split('/').slice(-1)[0] ?? entry.id}</span>
								</span>
							</button>
						)
					})}
				</>
			)}
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

	const displayEntries = showArchived ? entries : entries.filter((e) => e.active !== 0)
	const tree = buildTree(entries)

	return (
		<div className="flex flex-col h-full select-none">
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
			<div className="flex-1 overflow-y-auto py-2">
				{displayEntries.length === 0 ? (
					<p className="px-3 py-2 text-xs text-base-content/30 font-mono">No memories yet</p>
				) : (
					<FolderNode node={tree} depth={0} activeId={params.id} showArchived={showArchived} />
				)}
			</div>
		</div>
	)
}
