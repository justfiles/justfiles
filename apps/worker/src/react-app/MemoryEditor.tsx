import { UserButton } from '@clerk/clerk-react'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, type ReactNode } from 'react'
import { FiMenu, FiSettings } from 'react-icons/fi'
import { Editor } from './Editor'
import { useSidebarActions } from './SidebarContext'
import { useMemory } from './useMemory'

type Props = {
	id: string | null
	headerLeft?: ReactNode
	headerRight?: ReactNode
	footer?: ReactNode
	isLoading?: boolean
	readOnly?: boolean
	getToken?: () => Promise<string | null>
	updatedAt?: string
}

export function MemoryEditor({
	id,
	headerLeft,
	headerRight,
	footer,
	isLoading,
	readOnly,
	getToken,
	updatedAt
}: Props) {
	const navigate = useNavigate()
	const { toggleSidebar, sidebarOpen } = useSidebarActions()
	const { content, save, isLoading: isMemoryLoading } = useMemory(id)
	const showLoading = isLoading || isMemoryLoading

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				navigate({ to: '/settings' })
			}
		}
		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [navigate])

	return (
		<div className="flex-1 min-h-0 flex flex-col">
			<header className="safe-area-header shrink-0 flex items-center gap-2 px-3 py-2 border-b border-base-200">
				{!sidebarOpen && (
					<button
						type="button"
						onClick={toggleSidebar}
						title="Toggle sidebar"
						className="p-1.5 rounded-lg hover:bg-base-200 text-base-content/40 hover:text-base-content/80 transition-colors cursor-pointer shrink-0"
					>
						<FiMenu className="w-4 h-4" />
					</button>
				)}
				<div className="flex-1 min-w-0 hidden sm:block">{headerLeft}</div>
				<div className="ml-auto shrink-0 flex items-center gap-2">
					{headerRight}
					<UserButton appearance={{ elements: { avatarBox: 'w-6 h-6' } }}>
						<UserButton.MenuItems>
							<UserButton.Action
								label="Settings"
								labelIcon={<FiSettings />}
								onClick={() => navigate({ to: '/settings' })}
							/>
						</UserButton.MenuItems>
					</UserButton>
				</div>
			</header>
				<main className={`no-overscroll flex-1 overflow-y-auto transition-[filter] duration-150${showLoading ? ' blur-sm pointer-events-none' : ''}`}>
					<div className="safe-area-content max-w-[680px] mx-auto px-4 py-4 min-h-full flex flex-col">
						{headerLeft && <div className="sm:hidden w-full min-w-0 pb-2">{headerLeft}</div>}
						<div className="flex justify-between mb-2">
						<span className="text-[11px] text-base-content/30 font-mono">
							{updatedAt ? `updated: ${new Date(updatedAt).toLocaleString()}` : ''}
						</span>
					</div>
					{id && content ? (
						<div className="flex-1 flex flex-col min-h-0">
							<Editor
								key={id}
								value={content}
								onChange={save}
								memoryId={id}
								readOnly={readOnly}
								getToken={getToken}
							/>
						</div>
					) : (
						<p className="text-sm text-base-content/50 font-mono">{showLoading ? 'Loading…' : 'Empty'}</p>
					)}
					{footer}
				</div>
			</main>
		</div>
	)
}
