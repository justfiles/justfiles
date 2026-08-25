import { SignInButton, UserButton, useAuth } from '@clerk/clerk-react'
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useState,
	useSyncExternalStore
} from 'react'
import { ContextMenu, type ContextMenuItem, useContextMenu } from '@/components/ContextMenu'
import { Menubar } from '@/components/Menubar'
import { AgentAvatar } from '../agent/AgentAvatar'
import { useAgentConnection, useAgentSession } from '../agent/hooks'
import { MessagesPanel } from '../agent/MessagesPanel'
import type { ConnectionState } from '../agent/types'
import { AppViewport } from '../apps/AppViewport'
import { resolveAppTitle } from '../apps/catalog'
import { useAppCommands, useInstalledApps } from '../apps/hooks'
import type { InstalledApp } from '../apps/types'
import {
	activeProfileHasRemoteUser,
	activeStatus,
	factoryReset,
	onActiveStatusChange,
	resetTakeMine,
	resetTakeTheirs,
	type SyncStatus
} from '../fs'
import { AppWindow } from '../os/AppWindow'
import { useOsStore } from '../os/hooks'
import { selectFocusedAppId, selectOpenWindows, selectVisibleFullscreenId } from '../os/selectors'
import type { OsWindow } from '../os/state'
import { Omnibar } from './Omnibar'
import { Stickies } from './Stickies'
import { useWallpaper } from './wallpaper'

const statusDotColor: Record<ConnectionState, string> = {
	ready: '#22c55e',
	connecting: '#f59e0b',
	disconnected: '#ef4444'
}

const MIN_CHAT_WIDTH = 280
const MAX_CHAT_WIDTH = 720
const MIN_DESKTOP_WIDTH = 320

function maxChatWidth(): number {
	return Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, window.innerWidth - MIN_DESKTOP_WIDTH))
}

function clampChatWidth(width: number): number {
	return Math.min(maxChatWidth(), Math.max(MIN_CHAT_WIDTH, width))
}

// macOS-style menubar clock: short weekday + locale time, next to the avatar.
function formatClock(): string {
	return new Date().toLocaleString(undefined, {
		weekday: 'short',
		hour: 'numeric',
		minute: '2-digit'
	})
}

function MenubarClock() {
	const [now, setNow] = useState(formatClock)
	// Tick every second but re-render only when the minute string changes: setState
	// with an identical string is a no-op, so we don't need to align to the minute.
	useEffect(() => {
		const id = setInterval(() => setNow(formatClock()), 1000)
		return () => clearInterval(id)
	}, [])
	return (
		<span className="frn-menubar-clock" title="Current date and time">
			{now}
		</span>
	)
}

function syncLabel(status: SyncStatus): string {
	switch (status) {
		case 'synced':
			return 'Synced'
		case 'syncing':
			return 'Syncing…'
		case 'error':
			return 'Sync error'
		default:
			return 'Connecting…'
	}
}

function subscribeOnline(onChange: () => void): () => void {
	window.addEventListener('online', onChange)
	window.addEventListener('offline', onChange)
	return () => {
		window.removeEventListener('online', onChange)
		window.removeEventListener('offline', onChange)
	}
}

// Backend status: auth is optional, so this reflects the sync state when signed
// in and "Signed out" otherwise. The desktop boots and runs regardless. When
// `onOpenMenu` is given (debug builds) it becomes a button that opens the
// sync-reset menu; otherwise it stays a plain label.
function BackendStatus({ onOpenMenu }: { onOpenMenu?: (event: ReactMouseEvent) => void }) {
	const { isSignedIn } = useAuth()
	const status = useSyncExternalStore(
		onActiveStatusChange,
		activeStatus,
		() => 'local-only' as SyncStatus
	)
	const online = useSyncExternalStore(
		subscribeOnline,
		() => navigator.onLine,
		() => true
	)
	const label = !isSignedIn ? 'Signed out' : !online ? 'Offline' : syncLabel(status)
	if (onOpenMenu)
		return (
			<button
				type="button"
				className="frn-menubar-status frn-menubar-status-btn"
				title={`Backend: ${label} · reset sync`}
				onClick={onOpenMenu}
			>
				{label}
			</button>
		)
	return (
		<span className="frn-menubar-status" title={`Backend: ${label}`}>
			{label}
		</span>
	)
}

// Re-render the desktop only when the set/order of windows changes, not on
// every rect/mode edit — each AppWindow subscribes to its own slice.
function sameWindowIds(a: OsWindow[], b: OsWindow[]): boolean {
	return a.length === b.length && a.every((w, i) => w.id === b[i]?.id)
}

export function DesktopShell({ onSwitchUser }: { onSwitchUser: () => void }) {
	const { isSignedIn, getToken } = useAuth()
	const installedApps = useInstalledApps()
	const { launchApp, openSettings, uninstallApp } = useAppCommands()
	const connection = useAgentConnection()
	const agent = useAgentSession()
	const menu = useContextMenu()
	const focusedAppId = useOsStore(selectFocusedAppId)
	const [chatOpen, setChatOpen] = useState(false)
	const [chatWidth, setChatWidth] = useState(420)
	const [resizingChat, setResizingChat] = useState(false)

	const windows = useOsStore(
		(state) => (state.booted ? selectOpenWindows(state) : []),
		sameWindowIds
	)
	const fullscreenId = useOsStore(selectVisibleFullscreenId)
	const wallpaper = useWallpaper()

	const desktopMenuItems: ContextMenuItem[] = [
		{ label: 'Personalize…', onSelect: () => openSettings() },
		{ label: 'Switch User…', onSelect: onSwitchUser },
		{ separator: true },
		// The wallpaper is Settings' to change now — one writer, one pane, and a preview
		// of what you are choosing instead of a bare file picker.
		{ label: 'Change Wallpaper…', onSelect: () => openSettings('appearance') },
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

	// Sync-status menu: the three destructive volume resets (see fs.ts / synced.ts).
	// Each confirms first — all three throw data away and can't be undone. "Keep
	// mine"/"Keep server" need a synced profile; "Reset everything" always works.
	const syncedProfile = activeProfileHasRemoteUser()
	const runReset = (confirmMsg: string, op: () => Promise<void>) => () => {
		if (!confirm(confirmMsg)) return
		op().catch((e: unknown) => alert(e instanceof Error ? e.message : String(e)))
	}
	const syncMenuItems: ContextMenuItem[] = [
		{
			label: 'Keep this device (overwrite server & others)',
			disabled: !syncedProfile,
			onSelect: runReset(
				'Keep this device: overwrite the server with THIS device’s data. Every other device will discard its copy. This can’t be undone. Continue?',
				() => resetTakeMine()
			)
		},
		{
			label: 'Keep server (discard this device’s changes)',
			disabled: !syncedProfile,
			onSelect: runReset(
				'Keep server: discard THIS device’s local changes and re-download from the server. This can’t be undone. Continue?',
				() => resetTakeTheirs()
			)
		},
		{ separator: true },
		{
			label: 'Reset everything (wipe all devices)',
			onSelect: runReset(
				syncedProfile
					? 'Reset everything: wipe the server AND every device, then reseed the built-in apps. This deletes everything and can’t be undone. Continue?'
					: 'Reset everything: wipe this local workspace and reload. This deletes everything and can’t be undone. Continue?',
				() => factoryReset(() => getToken())
			)
		}
	]

	// The focused app labels the menubar (macOS-style); the desktop falls back to
	// the shell name. Version rides alongside in muted text when the app declares one.
	const focusedApp = focusedAppId ? installedApps.find((app) => app.id === focusedAppId) : undefined
	const startChatResize = (event: ReactPointerEvent<HTMLHRElement>) => {
		event.preventDefault()
		event.currentTarget.focus()
		setResizingChat(true)
	}
	const resizeChatWithKey = (event: ReactKeyboardEvent<HTMLHRElement>) => {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
		event.preventDefault()
		const step = event.shiftKey ? 40 : 16
		setChatWidth((width) => clampChatWidth(width + (event.key === 'ArrowLeft' ? step : -step)))
	}

	return (
		<div className="frn-shell">
			<div className="frn-desktop-frame">
				{fullscreenId ? null : (
					<Menubar>
						<div className="frn-menubar-group">
							<span className="frn-menubar-title">
								{focusedApp?.name ?? 'Kodama'}
								{focusedApp?.version ? (
									<span className="frn-menubar-version">{focusedApp.version}</span>
								) : null}
							</span>
						</div>
						<div className="frn-menubar-group">
							<BackendStatus onOpenMenu={(event) => menu.open(event, syncMenuItems)} />
							<span
								className="frn-status-dot"
								style={{ background: statusDotColor[connection.state] }}
								title={connection.state}
							/>
							<MenubarClock />
							{isSignedIn ? (
								<UserButton appearance={{ elements: { avatarBox: 'w-6 h-6' } }} />
							) : (
								<SignInButton>
									<button type="button" className="frn-menubar-btn">
										Sign in
									</button>
								</SignInButton>
							)}
						</div>
					</Menubar>
				)}

				{/* biome-ignore lint/a11y/noStaticElementInteractions: contextmenu is a supplemental pointer gesture on the desktop region */}
				<div
					className="frn-desktop"
					style={
						wallpaper
							? {
									backgroundImage: `url(${wallpaper})`,
									backgroundSize: 'cover',
									backgroundPosition: 'center'
								}
							: undefined
					}
					onContextMenu={(event) => menu.open(event, desktopMenuItems)}
				>
					<div className="frn-desktop-windows">
						<Stickies />
						{windows.map((window) =>
							window.appId ? (
								<AppWindow
									key={window.id}
									id={window.id}
									title={resolveAppTitle(installedApps, window.appId, window.title)}
								>
									<AppViewport id={window.id} />
								</AppWindow>
							) : null
						)}
					</div>
					{fullscreenId ? null : (
						<Omnibar
							chatOpen={chatOpen}
							onOpenChat={() => setChatOpen(true)}
							onAppMenu={(event, app) => menu.open(event, appMenuItems(app))}
						/>
					)}
				</div>
			</div>
			{chatOpen ? null : (
				<button
					type="button"
					className="frn-agent-launcher"
					onClick={() => setChatOpen(true)}
					aria-label={`Open conversation with ${agent.agentName}`}
					title={`Open conversation with ${agent.agentName}`}
				>
					<AgentAvatar
						url={agent.avatarUrl}
						faces={agent.avatarFaces}
						expression={agent.expression}
						streaming={agent.isStreaming}
						personalized={agent.personalized}
						size={56}
					/>
				</button>
			)}
			{chatOpen ? (
				<aside className="frn-chat-panel" aria-label="Agent chat" style={{ width: chatWidth }}>
					<hr
						className="frn-chat-resizer"
						aria-label="Resize chat panel"
						aria-orientation="vertical"
						aria-valuemin={MIN_CHAT_WIDTH}
						aria-valuemax={maxChatWidth()}
						aria-valuenow={chatWidth}
						tabIndex={0}
						onPointerDown={startChatResize}
						onKeyDown={resizeChatWithKey}
					/>
					<MessagesPanel onClose={() => setChatOpen(false)} onPersonalize={() => openSettings()} />
				</aside>
			) : null}
			{resizingChat ? (
				<div
					className="frn-chat-resize-layer"
					onPointerMove={(event) => setChatWidth(clampChatWidth(window.innerWidth - event.clientX))}
					onPointerUp={() => setResizingChat(false)}
					onPointerCancel={() => setResizingChat(false)}
				/>
			) : null}
			<ContextMenu state={menu.state} onClose={menu.close} />
		</div>
	)
}
