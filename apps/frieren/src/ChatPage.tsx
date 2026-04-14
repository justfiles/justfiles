import { UserButton } from '@clerk/clerk-react'
import { useState } from 'react'
import type { ReactElement } from 'react'
import { navigate } from './clientRouter'
import { useChat } from './chat/useChat'
import { ClassicView } from './chat/ClassicView'
import { JrpgView } from './chat/JrpgView'
import type { ChatViewProps, ConnectionState } from './chat/types'

type ViewMode = 'classic' | 'jrpg'

const VIEWS: Record<ViewMode, { label: string; component: (props: ChatViewProps) => ReactElement }> = {
	classic: { label: 'Classic', component: ClassicView },
	jrpg: { label: 'JRPG', component: JrpgView }
}

const ORDER: ViewMode[] = ['classic', 'jrpg']

const statusBadge: Record<ConnectionState, string> = {
	ready: 'badge-success',
	connecting: 'badge-warning',
	disconnected: 'badge-error'
}

export function ChatPage() {
	const chat = useChat()
	const [mode, setMode] = useState<ViewMode>(() => {
		const saved = localStorage.getItem('frieren-view-mode') as ViewMode | null
		return saved && saved in VIEWS ? saved : 'classic'
	})

	const cycleMode = () => {
		const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length]
		setMode(next)
		localStorage.setItem('frieren-view-mode', next)
	}

	const View = VIEWS[mode].component

	return (
		<div className="flex h-screen flex-col">
			<header className="navbar min-h-12 border-b border-base-300 px-4">
				<div className="flex flex-1 items-center gap-3">
					<span className="text-lg font-semibold">Frieren</span>
					<button
						type="button"
						className="btn btn-ghost btn-xs text-base-content/60"
						onClick={() => navigate('/files')}
					>
						Files
					</button>
				</div>
				<div className="flex flex-none items-center gap-2">
					<button type="button" className="btn btn-ghost btn-xs" onClick={cycleMode}>
						{VIEWS[mode].label} ▾
					</button>
					<span className={`badge badge-sm ${statusBadge[chat.connectionState]}`}>
						{chat.connectionState}
					</span>
					<UserButton appearance={{ elements: { avatarBox: 'w-6 h-6' } }} />
				</div>
			</header>

			<View {...chat} />

			{chat.connectionState === 'disconnected' ? (
				<div className="px-4 pb-4">
					<button
						type="button"
						className="btn btn-outline btn-block btn-sm"
						onClick={chat.reconnect}
					>
						Reconnect
					</button>
				</div>
			) : null}
		</div>
	)
}
