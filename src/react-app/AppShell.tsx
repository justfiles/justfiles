import { Outlet } from '@tanstack/react-router'
import { useState } from 'react'
import { FiMenu } from 'react-icons/fi'
import { CommandPalette } from './CommandPalette'
import { Sidebar } from './Sidebar'
import { SidebarContext } from './SidebarContext'
import { useSidebar } from './useSidebar'

const LS_KEY = 'ghostore:sidebar-open'

function loadSidebarOpen(): boolean {
	try { return localStorage.getItem(LS_KEY) === 'true' } catch { return false }
}

export function AppShell() {
	const { entries, upsertEntry, removeEntry, refresh } = useSidebar()
	const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen)

	function toggle() {
		setSidebarOpen((o: boolean) => {
			const next = !o
			try { localStorage.setItem(LS_KEY, String(next)) } catch {}
			return next
		})
	}

	return (
		<SidebarContext.Provider value={{ upsertEntry, removeEntry, refresh }}>
			<div className="flex h-screen overflow-hidden">
				{sidebarOpen && (
					<aside className="w-64 shrink-0 bg-base-200 border-r border-base-300 h-full overflow-hidden flex flex-col">
						<Sidebar entries={entries} onClose={toggle} />
					</aside>
				)}
				<div className="flex-1 min-w-0 h-full flex flex-col overflow-hidden relative">
					<CommandPalette />
					{!sidebarOpen && (
						<button
							type="button"
							onClick={toggle}
							title="Toggle sidebar"
							className="absolute top-3 left-3 z-10 p-1.5 rounded-lg hover:bg-base-200 text-base-content/40 hover:text-base-content/80 transition-colors cursor-pointer"
						>
							<FiMenu className="w-4 h-4" />
						</button>
					)}
					<Outlet />
				</div>
			</div>
		</SidebarContext.Provider>
	)
}
