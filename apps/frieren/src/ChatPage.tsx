import { UserButton, useAuth } from '@clerk/clerk-react'
import { ChatTeardropDotsIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ContextMenu, type ContextMenuItem, useContextMenu } from '@/components/ContextMenu'
import { Menubar } from '@/components/Menubar'
import { Button } from '@/components/ui/button'
import { Window, type WindowPersist } from '@/components/Window'
import { MessagesPanel } from './chat/MessagesPanel'
import type { ConnectionState, InstalledApp } from './chat/types'
import { ChatProvider, useChat } from './chat/useChat'
import { createFsVolume } from './fs'
import { KernelAppFrame } from './KernelAppFrame'
import { loadWindowRect, saveWindowRect } from './windowState'

// Persistence key for the OS-level chat window. Kept distinct from any
// kernel-app id so window rects don't collide with installed apps.
const CHAT_WINDOW_KEY = 'system:chat'

const statusDotColor: Record<ConnectionState, string> = {
	ready: '#22c55e',
	connecting: '#f59e0b',
	disconnected: '#ef4444'
}

function useWindowPersistence(): (appId: string) => WindowPersist {
	const { getToken } = useAuth()
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken
	const [volumePromise] = useState(() => createFsVolume(() => getTokenRef.current()))
	const cacheRef = useRef<Map<string, WindowPersist>>(new Map())

	return useCallback(
		(appId: string) => {
			let entry = cacheRef.current.get(appId)
			if (!entry) {
				entry = {
					load: async () => {
						try {
							return await loadWindowRect(await volumePromise, appId)
						} catch {
							return null
						}
					},
					save: (rect) => {
						void volumePromise.then((vol) => saveWindowRect(vol, appId, rect)).catch(() => {})
					}
				}
				cacheRef.current.set(appId, entry)
			}
			return entry
		},
		[volumePromise]
	)
}

export function ChatPage({ onSwitchUser }: { onSwitchUser: () => void }) {
	const chat = useChat()
	const { connection, apps } = chat
	const { launcher } = apps
	const desktopApps: InstalledApp[] = launcher.installedApps
	const persistFor = useWindowPersistence()
	const menu = useContextMenu()
	const [fullscreenKey, setFullscreenKey] = useState<string | null>(null)
	// OS-level chat surface — not an app, not in launcher.openApps. Open/close
	// is per-session for now; persistence is just a future polish item.
	const [chatOpen, setChatOpen] = useState(false)

	useEffect(() => {
		if (!fullscreenKey) return
		const stillOpen = launcher.openApps.some((app) => app.id === fullscreenKey)
		if (!stillOpen) setFullscreenKey(null)
	}, [launcher.openApps, fullscreenKey])

	const desktopMenuItems: ContextMenuItem[] = [
		{ label: 'Switch User…', onSelect: onSwitchUser },
		{ separator: true },
		{ label: 'Change Wallpaper…', disabled: true, onSelect: () => {} },
		{ separator: true },
		{ label: 'Clean Up', disabled: true, onSelect: () => {} }
	]

	const appMenuItems = (app: InstalledApp): ContextMenuItem[] => {
		const items: ContextMenuItem[] = [{ label: 'Open', onSelect: () => launcher.launch(app) }]
		if (launcher.uninstallApp) {
			items.push(
				{ separator: true },
				{
					label: 'Uninstall',
					onSelect: () => {
						if (confirm(`Uninstall "${app.name}"?`)) void launcher.uninstallApp?.(app.id)
					}
				}
			)
		}
		return items
	}

	return (
		<ChatProvider value={chat}>
			<div className="flex h-screen flex-col">
				{fullscreenKey ? null : (
					<Menubar>
						<div className="flex items-center gap-1">
							<span className="font-medium">Frieren</span>
						</div>
						<div className="flex items-center gap-3">
							<span
								className="inline-block size-1.5 rounded-full"
								style={{ background: statusDotColor[connection.state] }}
								title={connection.state}
							/>
							{launcher.installApp ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => void launcher.installApp?.()}
									title="Install app from zip"
								>
									Install
								</Button>
							) : null}
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								onClick={() => setChatOpen((open) => !open)}
								title={chatOpen ? 'Close Messages' : 'Open Messages'}
								aria-label="Toggle Messages"
								aria-pressed={chatOpen}
							>
								<ChatTeardropDotsIcon weight={chatOpen ? 'fill' : 'regular'} />
							</Button>
							<UserButton appearance={{ elements: { avatarBox: 'w-6 h-6' } }} />
						</div>
					</Menubar>
				)}

				{/* biome-ignore lint/a11y/noStaticElementInteractions: contextmenu is a supplemental pointer gesture on the desktop region */}
				<div
					className="relative flex flex-1 overflow-hidden"
					style={{ background: 'var(--desktop-bg)' }}
					onContextMenu={(event) => menu.open(event, desktopMenuItems)}
				>
					<div className="absolute top-4 right-4 flex flex-col gap-4">
						{desktopApps.map((app) => (
							// biome-ignore lint/a11y/noStaticElementInteractions: contextmenu is a supplemental pointer gesture on the icon group
							<div
								key={app.id}
								className="group relative flex w-20 flex-col items-center"
								onContextMenu={(event) => menu.open(event, appMenuItems(app))}
							>
								<button
									type="button"
									onClick={() => launcher.launch(app)}
									className="flex w-full flex-col items-center gap-1.5 text-center"
									title={app.description || app.name}
								>
									<span className="flex size-16 items-center justify-center overflow-hidden rounded-xl border border-white/20 bg-white/15 text-xl font-semibold text-white shadow-[0_4px_14px_rgba(0,0,0,0.25)] backdrop-blur-sm transition group-hover:bg-white/25">
										{app.iconUrl ? (
											<img src={app.iconUrl} alt="" className="size-full object-cover" />
										) : (
											app.name.slice(0, 1).toUpperCase()
										)}
									</span>
									<span className="w-full truncate text-xs font-medium text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">
										{app.name}
									</span>
								</button>
							</div>
						))}
					</div>
					{launcher.openApps.map((app, index) => {
						const key = app.id
						const info = desktopApps.find((d) => d.id === app.id)
						const focused = launcher.focusedId === key
						const isFullscreen = fullscreenKey === key
						return (
							<Window
								key={key}
								title={info?.name ?? ''}
								onClose={launcher.close}
								onFocus={() => launcher.focus(app)}
								focused={focused}
								zIndex={index + 1}
								initialOffset={index * 24}
								persist={persistFor(app.id)}
								fullscreen={isFullscreen}
								onFullscreenToggle={() => {
									launcher.focus(app)
									setFullscreenKey(isFullscreen ? null : key)
								}}
							>
								<KernelAppFrame id={app.id} guiUrl={info?.guiUrl} />
							</Window>
						)
					})}
					{chatOpen ? (
						<Window
							title="Messages"
							onClose={() => setChatOpen(false)}
							focused={true}
							zIndex={launcher.openApps.length + 100}
							persist={persistFor(CHAT_WINDOW_KEY)}
						>
							<MessagesPanel />
						</Window>
					) : null}
				</div>
				<ContextMenu state={menu.state} onClose={menu.close} />
			</div>
		</ChatProvider>
	)
}
