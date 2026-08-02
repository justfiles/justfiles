import { SignInButton, UserButton, useAuth } from '@clerk/clerk-react'
import {
	type MouseEvent as ReactMouseEvent,
	useEffect,
	useState,
	useSyncExternalStore
} from 'react'
import { ContextMenu, type ContextMenuItem, useContextMenu } from '@/components/ContextMenu'
import { Menubar } from '@/components/Menubar'
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
import { useWallpaper } from './wallpaper'

const statusDotColor: Record<ConnectionState, string> = {
	ready: '#22c55e',
	connecting: '#f59e0b',
	disconnected: '#ef4444'
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
	const { agentName } = useAgentSession()
	const menu = useContextMenu()
	const focusedAppId = useOsStore(selectFocusedAppId)

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

	return (
		<div className="frn-shell">
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
				{/* Windows live in their own layer so the desktop can dim + recede behind
				    the omnibar's expanded sheet without transforming the omnibar itself.
				    The body is picked by window kind: app windows present their stage,
				    the agent window views the conversation session. */}
				<div className="frn-desktop-windows">
					{windows.map((window) => (
						<AppWindow
							key={window.id}
							id={window.id}
							title={
								window.appId
									? resolveAppTitle(installedApps, window.appId, window.title)
									: agentName
							}
						>
							{window.appId ? (
								<AppViewport id={window.id} />
							) : (
								<MessagesPanel onPersonalize={() => openSettings()} />
							)}
						</AppWindow>
					))}
				</div>
				{fullscreenId ? null : (
					<Omnibar
						onAppMenu={(event, app) => menu.open(event, appMenuItems(app))}
						onPersonalize={() => openSettings()}
					/>
				)}
			</div>
			<ContextMenu state={menu.state} onClose={menu.close} />
		</div>
	)
}
