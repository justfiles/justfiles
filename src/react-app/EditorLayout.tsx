import { UserButton } from '@clerk/clerk-react'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, type ReactNode } from 'react'
import { FiMenu, FiSettings } from 'react-icons/fi'
import { MarkdownEditor } from './MarkdownEditor'
import { useSidebarActions } from './SidebarContext'

type Props = {
	headerLeft?: ReactNode
	headerRight?: ReactNode
	value: string
	onChange: (v: string) => void
	isLoading?: boolean
}

export function EditorLayout({ headerLeft, headerRight, value, onChange, isLoading }: Props) {
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
				<div className="flex-1 min-w-0">{headerLeft}</div>
				<div className="shrink-0 flex items-center gap-2">
					{headerRight}
					<UserButton appearance={{ elements: { avatarBox: 'w-6 h-6' } }} />
					<button
						type="button"
						title="Settings (⌘,)"
						onClick={() => navigate({ to: '/settings' })}
						className="flex items-center justify-center w-6 h-6 opacity-50 hover:opacity-100 transition-opacity cursor-pointer"
					>
						<FiSettings className="w-4 h-4" />
					</button>
				</div>
			</header>
			<main className={`flex-1 overflow-y-auto transition-[filter] duration-150${isLoading ? ' blur-sm pointer-events-none' : ''}`}>
				<div className="max-w-[680px] mx-auto px-4 py-4 min-h-full flex flex-col">
					<MarkdownEditor value={value} onChange={onChange} />
				</div>
			</main>
		</div>
	)
}
