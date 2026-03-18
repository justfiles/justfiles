import { UserButton } from '@clerk/clerk-react'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, type ReactNode } from 'react'
import { FiSettings } from 'react-icons/fi'
import { MarkdownEditor } from './MarkdownEditor'

type Props = {
	header?: ReactNode
	value: string
	onChange: (v: string) => void
	minibufferLeft?: ReactNode
	minibufferRight?: ReactNode
}

export function EditorLayout({ header, value, onChange, minibufferLeft, minibufferRight }: Props) {
	const navigate = useNavigate()

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
			{header && (
				<header className="shrink-0 flex justify-center">
					<div className="w-full max-w-[680px] flex items-center border-b border-neutral-content/50 p-4">
						{header}
					</div>
				</header>
			)}
			<main className="flex-1 min-h-0 flex justify-center px-4 pb-4">
				<div className="w-full max-w-[680px] h-full">
					<MarkdownEditor value={value} onChange={onChange} />
				</div>
			</main>
			<div className="w-full shrink-0 flex items-center gap-3 px-4 py-1.5 border-t border-base-200 bg-base-200 text-xs text-base-content/60 font-mono">
				<UserButton appearance={{ elements: { avatarBox: 'w-4 h-4' } }} />
				<span className="truncate flex-1">{minibufferLeft}</span>
				<span className="shrink-0 flex items-center gap-3">{minibufferRight}</span>
				<button
					type="button"
					title="Settings (⌘,)"
					onClick={() => navigate({ to: '/settings' })}
					className="flex items-center justify-center w-4 h-4 opacity-50 hover:opacity-100 transition-opacity cursor-pointer"
				>
					<FiSettings className="w-3.5 h-3.5" />
				</button>
			</div>
		</div>
	)
}
