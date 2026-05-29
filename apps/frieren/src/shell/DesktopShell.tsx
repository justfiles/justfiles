import { UserButton } from '@clerk/clerk-react'
import { ChatTeardropDotsIcon } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import { ContextMenu, type ContextMenuItem, useContextMenu } from '@/components/ContextMenu'
import { Dock } from '@/components/Dock'
import { Menubar } from '@/components/Menubar'
import { Button } from '@/components/ui/button'
import { Window } from '@/components/Window'
import { useAgentConnection } from '../agent/hooks'
import { MessagesPanel } from '../agent/MessagesPanel'
import type { ConnectionState } from '../agent/types'
import { AppViewport } from '../apps/AppViewport'
import { resolveAppTitle } from '../apps/catalog'
import { useAppCommands, useInstalledApps } from '../apps/hooks'
import type { InstalledApp } from '../apps/types'
import { AppWindow } from '../os/AppWindow'
import { useOsDispatch, useOsStore } from '../os/hooks'
import { selectAgentOpen, selectOpenWindows, selectVisibleFullscreenId } from '../os/selectors'
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
	const installedApps = useInstalledApps()
	const { launchApp, installApp, uninstallApp } = useAppCommands()
	const connection = useAgentConnection()
	const dispatch = useOsDispatch()
	const menu = useContextMenu()

	const windows = useOsStore(
		(state) => (state.booted ? selectOpenWindows(state) : []),
		sameWindowIds
	)
	const agentOpen = useOsStore(selectAgentOpen)
	const fullscreenId = useOsStore(selectVisibleFullscreenId)
	// `windows` only changes identity when the open set/order changes, so the
	// running set stays stable across rect/mode edits.
	const openAppIds = useMemo(() => new Set(windows.map((w) => w.appId)), [windows])
	// The agent surface is an overlay, not a persisted window — its position is
	// session-local and lives here, not in OS state.
	const [agentRect, setAgentRect] = useState<WindowRect>(() => ({ x: 120, y: 80, w: 420, h: 560 }))

	const desktopMenuItems: ContextMenuItem[] = [
		{ label: 'Switch User…', onSelect: onSwitchUser },
		{ separator: true },
		{ label: 'Change Wallpaper…', disabled: true, onSelect: () => {} },
		{ separator: true },
		{ label: 'Clean Up', disabled: true, onSelect: () => {} }
	]

	const appMenuItems = (app: InstalledApp): ContextMenuItem[] => [
		{ label: 'Open', onSelect: () => launchApp(app) },
		{ separator: true },
		{
			label: 'Uninstall',
			onSelect: () => {
				if (confirm(`Uninstall "${app.name}"?`)) void uninstallApp(app.id)
			}
		}
	]

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
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => void installApp()}
							title="Install app from zip"
						>
							Install
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							onClick={() => dispatch({ type: 'agent.setOpen', open: !agentOpen })}
							title={agentOpen ? 'Close Messages' : 'Open Messages'}
							aria-label="Toggle Messages"
							aria-pressed={agentOpen}
						>
							<ChatTeardropDotsIcon weight={agentOpen ? 'fill' : 'regular'} />
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
				{windows.map((window) => (
					<AppWindow
						key={window.id}
						id={window.id}
						title={resolveAppTitle(installedApps, window.appId, window.title)}
					>
						<AppViewport id={window.id} />
					</AppWindow>
				))}
				{agentOpen ? (
					<Window
						title="Messages"
						rect={agentRect}
						focused={true}
						zIndex={windows.length + 100}
						onClose={() => dispatch({ type: 'agent.setOpen', open: false })}
						onRectCommit={setAgentRect}
					>
						<MessagesPanel />
					</Window>
				) : null}
				{fullscreenId ? null : (
					<Dock
						apps={installedApps}
						openAppIds={openAppIds}
						onLaunch={launchApp}
						onContextMenu={(event, app) => menu.open(event, appMenuItems(app))}
					/>
				)}
			</div>
			<ContextMenu state={menu.state} onClose={menu.close} />
		</div>
	)
}
