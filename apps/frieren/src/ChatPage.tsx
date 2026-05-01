import { UserButton } from '@clerk/clerk-react'
import type { ReactElement } from 'react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { ClassicView } from './chat/ClassicView'
import { JrpgView } from './chat/JrpgView'
import { ShadcnView } from './chat/ShadcnView'
import type { ChatViewProps, ConnectionState } from './chat/types'
import { useChat } from './chat/useChat'
import { navigate } from './clientRouter'
import { cn } from './lib/utils'

type ViewMode = 'classic' | 'jrpg' | 'shadcn'

const VIEWS: Record<
	ViewMode,
	{ label: string; component: (props: ChatViewProps) => ReactElement }
> = {
	classic: { label: 'Classic', component: ClassicView },
	jrpg: { label: 'JRPG', component: JrpgView },
	shadcn: { label: 'Shadcn', component: ShadcnView }
}

const statusBadgeClass: Record<ConnectionState, string> = {
	ready: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
	connecting: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
	disconnected: 'border-destructive/30 bg-destructive/10 text-destructive'
}

export function ChatPage() {
	const chat = useChat()
	const [mode, setMode] = useState<ViewMode>(() => {
		const saved = localStorage.getItem('frieren-view-mode') as ViewMode | null
		return saved && saved in VIEWS ? saved : 'shadcn'
	})

	const View = VIEWS[mode].component

	return (
		<div className="flex h-screen flex-col bg-background">
			<header className="flex min-h-14 items-center justify-between border-b bg-background/95 px-4 backdrop-blur">
				<div className="flex flex-1 items-center gap-3">
					<div>
						<p className="text-sm font-semibold tracking-tight">Frieren</p>
						<p className="text-xs text-muted-foreground">Conversation</p>
					</div>
					<Button type="button" variant="ghost" size="sm" onClick={() => navigate('/files')}>
						Files
					</Button>
				</div>
				<div className="flex flex-none items-center gap-2">
					<div className="flex items-center gap-2">
						<span className="text-xs text-muted-foreground">Style</span>
						<NativeSelect
							size="sm"
							className="w-28"
							value={mode}
							onChange={(event) => {
								const next = event.target.value as ViewMode
								setMode(next)
								localStorage.setItem('frieren-view-mode', next)
							}}
							aria-label="Chat style"
						>
							{Object.entries(VIEWS).map(([value, view]) => (
								<NativeSelectOption key={value} value={value}>
									{view.label}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
					<Badge
						variant="outline"
						className={cn('capitalize', statusBadgeClass[chat.connectionState])}
					>
						{chat.connectionState}
					</Badge>
					<UserButton appearance={{ elements: { avatarBox: 'w-6 h-6' } }} />
				</div>
			</header>

			<View {...chat} />

			{chat.connectionState === 'disconnected' ? (
				<div className="border-t p-4">
					<Button type="button" variant="outline" className="w-full" onClick={chat.reconnect}>
						Reconnect
					</Button>
				</div>
			) : null}
		</div>
	)
}
