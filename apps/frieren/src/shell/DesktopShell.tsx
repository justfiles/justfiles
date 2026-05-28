import { UserButton } from '@clerk/clerk-react'
import { ChatTeardropDotsIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { ContextMenu, type ContextMenuItem, useContextMenu } from '@/components/ContextMenu'
import { Menubar } from '@/components/Menubar'
import { Button } from '@/components/ui/button'
import { Window } from '@/components/Window'
import { useAgentConnection } from '../agent/hooks'
import { MessagesPanel } from '../agent/MessagesPanel'
import type { ConnectionState } from '../agent/types'
import { AppViewport } from '../apps/AppViewport'
import type { InstalledApp } from '../chat/types'
import { useLauncher } from '../chat/useChat'
import { AppWindow } from '../os/AppWindow'
import { useOsDispatch, useOsStore } from '../os/hooks'
import { selectChatOpen, selectOpenWindows, selectVisibleFullscreenId } from '../os/selectors'
import type { OsWindow, WindowRect } from '../os/state'

const statusDotColor: Record<ConnectionState, string> = {
	ready: '#22c55e',
	connecting: '#f59e0b',
	disconnected: '#ef4444'
}

// Re-render the desktop only when the set/order of windows changes, not on
// every rect/mode edit — each AppWindow subscribes to its own slice.
function sameWindowIds(a: OsWindow[], b: OsWindow[]): boolean {
	return a.length === b.length && a.every((w, i) => w.id === b[i]?.id)
}

export function DesktopShell({ onSwitchUser }: { onSwitchUser: () => void }) {
	const launcher = useLauncher()
	const connection = useAgentConnection()
	const dispatch = useOsDispatch()
	const desktopApps: InstalledApp[] = launcher.installedApps
	const menu = useContextMenu()

	const windows = useOsStore(selectOpenWindows, sameWindowIds)
	const chatOpen = useOsStore(selectChatOpen)
	const fullscreenId = useOsStore(selectVisibleFullscreenId)
	// The chat surface is an overlay, not a persisted window — its position is
	// session-local and lives here, not in OS state.
	const [chatRect, setChatRect] = useState<WindowRect>(() => ({ x: 120, y: 80, w: 420, h: 560 }))

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
		<div className="flex h-screen flex-col">
			{fullscreenId ? null : (
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
							onClick={() => dispatch({ type: 'chat.setOpen', open: !chatOpen })}
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
				{windows.map((window) => (
					<AppWindow key={window.id} id={window.id}>
						<AppViewport id={window.id} />
					</AppWindow>
				))}
				{chatOpen ? (
					<Window
						title="Messages"
						rect={chatRect}
						focused={true}
						zIndex={windows.length + 100}
						onClose={() => dispatch({ type: 'chat.setOpen', open: false })}
						onRectCommit={setChatRect}
					>
						<MessagesPanel />
					</Window>
				) : null}
			</div>
			<ContextMenu state={menu.state} onClose={menu.close} />
		</div>
	)
}
