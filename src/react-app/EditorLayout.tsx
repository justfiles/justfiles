import { UserButton } from '@clerk/clerk-react'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, type ReactNode } from 'react'
import { CommandPalette } from './CommandPalette'
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
		<div className="w-screen h-screen flex flex-col bg-slate-50 text-slate-900">
			<CommandPalette />
			<div className="flex flex-col items-center px-4 pt-10 flex-1 min-h-0 overflow-hidden">
				{header && (
					<header className="w-full max-w-[680px] flex items-center justify-end mb-6 shrink-0">
						{header}
					</header>
				)}
				<div className="w-full max-w-[680px] flex-1 min-h-0 overflow-hidden">
					<MarkdownEditor value={value} onChange={onChange} className="border-0 bg-transparent rounded-none h-full" />
				</div>
			</div>
			<div className="w-full shrink-0 flex items-center gap-3 px-4 py-1.5 border-t border-slate-200 bg-slate-100 text-xs text-slate-500 font-mono">
				<UserButton appearance={{ elements: { avatarBox: 'w-4 h-4' } }} />
				<span className="truncate flex-1">{minibufferLeft}</span>
				<span className="shrink-0 flex items-center gap-3">{minibufferRight}</span>
				<button
					type="button"
					title="Settings (⌘,)"
					onClick={() => navigate({ to: '/settings' })}
					className="flex items-center justify-center w-4 h-4 opacity-50 hover:opacity-100 transition-opacity cursor-pointer"
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
						<path fillRule="evenodd" d="M8.34 1.804A1 1 0 0 1 9.32 1h1.36a1 1 0 0 1 .98.804l.295 1.473c.497.144.971.342 1.416.587l1.25-.834a1 1 0 0 1 1.262.125l.962.962a1 1 0 0 1 .125 1.262l-.834 1.25c.245.445.443.919.587 1.416l1.473.295A1 1 0 0 1 19 9.32v1.36a1 1 0 0 1-.804.98l-1.473.295a6.95 6.95 0 0 1-.587 1.416l.834 1.25a1 1 0 0 1-.125 1.262l-.962.962a1 1 0 0 1-1.262.125l-1.25-.834a6.953 6.953 0 0 1-1.416.587l-.295 1.473A1 1 0 0 1 10.68 19H9.32a1 1 0 0 1-.98-.804l-.295-1.473a6.957 6.957 0 0 1-1.416-.587l-1.25.834a1 1 0 0 1-1.262-.125l-.962-.962a1 1 0 0 1-.125-1.262l.834-1.25a6.957 6.957 0 0 1-.587-1.416l-1.473-.295A1 1 0 0 1 1 10.68V9.32a1 1 0 0 1 .804-.98l1.473-.295c.144-.497.342-.971.587-1.416l-.834-1.25a1 1 0 0 1 .125-1.262l.962-.962A1 1 0 0 1 5.38 3.03l1.25.834a6.957 6.957 0 0 1 1.416-.587l.295-1.473ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clipRule="evenodd" />
					</svg>
				</button>
			</div>
		</div>
	)
}
