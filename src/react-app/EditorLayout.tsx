import { UserButton } from '@clerk/clerk-react'
import type { ReactNode } from 'react'
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
			</div>
		</div>
	)
}
