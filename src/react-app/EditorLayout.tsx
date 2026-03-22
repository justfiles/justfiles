import { UserButton } from '@clerk/clerk-react'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, type ReactNode } from 'react'
import { FiMenu, FiSettings } from 'react-icons/fi'
import { Editor as MarkdownEditor } from './Editor'
import { useSidebarActions } from './SidebarContext'

type Props = {
	headerLeft?: ReactNode
	headerRight?: ReactNode
	value: string
	onChange: (v: string) => void
	isLoading?: boolean
	memoryId?: string
	getToken?: () => Promise<string | null>
	updatedAt?: string
}

export function EditorLayout({
	headerLeft,
	headerRight,
	value,
	onChange,
	isLoading,
	memoryId,
	getToken,
	updatedAt
}: Props) {
	const navigate = useNavigate()
	const { toggleSidebar, sidebarOpen } = useSidebarActions()

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
			<header className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-base-200">
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
			<main
				className={`flex-1 overflow-y-auto transition-[filter] duration-150${isLoading ? ' blur-sm pointer-events-none' : ''}`}
			>
				<div className="max-w-[680px] mx-auto px-4 py-4 min-h-full flex flex-col">
					{headerLeft && <div className="sm:hidden w-full min-w-0 pb-2">{headerLeft}</div>}
					<div className="flex justify-between mb-2">
						<span className="text-[11px] text-base-content/30 font-mono">
							{updatedAt ? `updated: ${new Date(updatedAt).toLocaleString()}` : ''}
						</span>
						<span className="text-[11px] text-base-content/30 font-mono">
							{(() => {
								const cjk = (value.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) ?? []).length
								const latin = value
									.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, ' ')
									.trim()
									.split(/\s+/)
									.filter(Boolean).length
								return (cjk + latin).toLocaleString() + ' words'
							})()}
						</span>
					</div>
					<MarkdownEditor
						value={value}
						onChange={onChange}
						memoryId={memoryId}
						getToken={getToken}
					/>
				</div>
			</main>
		</div>
	)
}
