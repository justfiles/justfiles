import { UserButton } from '@clerk/clerk-react'
import type { ReactElement } from 'react'
import { useState } from 'react'
import { Menubar } from '@/components/Menubar'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { ClassicView } from './chat/ClassicView'
import { JrpgView } from './chat/JrpgView'
import { ShadcnView } from './chat/ShadcnView'
import type { ChatViewProps, ConnectionState } from './chat/types'
import { useChat } from './chat/useChat'
import { navigate } from './clientRouter'

type ViewMode = 'classic' | 'jrpg' | 'shadcn'

const VIEWS: Record<
	ViewMode,
	{ label: string; component: (props: ChatViewProps) => ReactElement }
> = {
	classic: { label: 'Classic', component: ClassicView },
	jrpg: { label: 'JRPG', component: JrpgView },
	shadcn: { label: 'Shadcn', component: ShadcnView }
}

const statusDotColor: Record<ConnectionState, string> = {
	ready: '#22c55e',
	connecting: '#f59e0b',
	disconnected: '#ef4444'
}

export function ChatPage() {
	const { session, connection, apps } = useChat()
	const [mode, setMode] = useState<ViewMode>(() => {
		const saved = localStorage.getItem('frieren-view-mode') as ViewMode | null
		return saved && saved in VIEWS ? saved : 'shadcn'
	})

	const View = VIEWS[mode].component

	return (
		<div className="flex h-screen flex-col bg-background">
			<Menubar>
				<div className="flex items-center gap-1">
					<span className="font-medium">Frieren</span>
					<Button type="button" variant="ghost" size="sm" onClick={() => navigate('/files')}>
						Files
					</Button>
				</div>
				<div className="flex items-center gap-3">
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
					<span className="flex items-center gap-1.5 capitalize text-muted-foreground">
						<span
							className="inline-block size-1.5 rounded-full"
							style={{ background: statusDotColor[connection.state] }}
						/>
						{connection.state}
					</span>
					<UserButton appearance={{ elements: { avatarBox: 'w-6 h-6' } }} />
				</div>
			</Menubar>

			<View session={session} connection={connection} apps={apps} />

			{connection.state === 'disconnected' ? (
				<div className="border-t p-4">
					<Button type="button" variant="outline" className="w-full" onClick={connection.reconnect}>
						Reconnect
					</Button>
				</div>
			) : null}
		</div>
	)
}
