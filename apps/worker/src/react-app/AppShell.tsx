import { useAuth } from '@clerk/clerk-react'
import { persistStorage } from '@justfiles/fs/store.idb'
import { Outlet } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AuthWall } from './AuthWall'
import { CommandPalette } from './CommandPalette'
import { LayoutModeProvider } from './layoutMode'
import { PWAToast } from './PWAToast'
import { SidebarContext } from './SidebarContext'
import { loadSettings } from './settings'
import { useVolume, VolumeProvider } from './useVolume'

function AppShellInner({ userId }: { userId: string }) {
	const { upsertEntry, removeEntry, refresh } = useVolume()

	// Best-effort storage can be evicted whole — IndexedDB and the Cache API
	// together — and Safari drops it after seven days without interaction.
	useEffect(() => {
		persistStorage().then((granted) => {
			if (!granted) console.warn('storage is best-effort: the browser may evict this volume')
		})
	}, [])

	// Prevent iOS from using non-scrollable areas as a handle to scroll the
	// viewport when the keyboard toolbar appears. Touches inside any
	// overflow-y-auto container are allowed through for normal scroll.
	useEffect(() => {
		function onTouchMove(e: TouchEvent) {
			if (!(e.target as Element | null)?.closest('.overflow-y-auto')) {
				e.preventDefault()
			}
		}
		document.addEventListener('touchmove', onTouchMove, { passive: false })
		return () => document.removeEventListener('touchmove', onTouchMove)
	}, [])

	const [theme, setTheme] = useState(() => loadSettings(userId).theme)

	useEffect(() => {
		document.documentElement.setAttribute('data-theme', theme)
	}, [theme])

	// Listen for theme changes saved by SettingsPage
	useEffect(() => {
		function onStorage(e: StorageEvent) {
			if (e.key?.includes(':settings') && e.newValue) {
				try {
					const parsed = JSON.parse(e.newValue) as { theme?: string }
					if (parsed.theme) setTheme(parsed.theme)
				} catch {}
			}
		}
		window.addEventListener('storage', onStorage)
		return () => window.removeEventListener('storage', onStorage)
	}, [])

	return (
		<SidebarContext.Provider value={{ upsertEntry, removeEntry, refresh }}>
			<PWAToast />
			<CommandPalette />
			<LayoutModeProvider>
				<div className="app-shell bg-base-200">
					<Outlet />
				</div>
			</LayoutModeProvider>
		</SidebarContext.Provider>
	)
}

export function AppShell() {
	const { isLoaded, isSignedIn, userId } = useAuth()

	if (!isLoaded) return <p className="m-8">Loading…</p>
	if (!isSignedIn || !userId) return <AuthWall />

	return (
		<VolumeProvider userId={userId}>
			<AppShellInner userId={userId} />
		</VolumeProvider>
	)
}
