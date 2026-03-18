import { Outlet } from '@tanstack/react-router'
import { useState } from 'react'
import { FiMenu } from 'react-icons/fi'
import { CommandPalette } from './CommandPalette'
import { Sidebar } from './Sidebar'
import { SidebarContext } from './SidebarContext'
import { useSidebar } from './useSidebar'

const LS_KEY = 'ghostore:sidebar-open'

function loadSidebarOpen(): boolean {
	try { return localStorage.getItem(LS_KEY) !== 'false' } catch { return true }
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
			<div className={`drawer h-screen ${sidebarOpen ? 'drawer-open' : ''}`}>
				<input type="checkbox" className="drawer-toggle" readOnly checked={sidebarOpen} />
				<div className="drawer-content flex flex-col relative min-w-0">
					<CommandPalette />
					<button
						type="button"
						onClick={toggle}
						title="Toggle sidebar"
						className="absolute top-3 left-3 z-10 p-1.5 rounded-lg hover:bg-base-200 text-base-content/40 hover:text-base-content/80 transition-colors cursor-pointer"
					>
						<FiMenu className="w-4 h-4" />
					</button>
					<Outlet />
				</div>
				<div className="drawer-side z-20">
					<label className="drawer-overlay" onClick={toggle} />
					<aside className="w-56 bg-base-100 border-r border-base-200 h-full overflow-hidden flex flex-col">
						<Sidebar entries={entries} />
					</aside>
				</div>
			</div>
		</SidebarContext.Provider>
	)
}
