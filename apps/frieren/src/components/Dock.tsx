import type { MouseEvent as ReactMouseEvent } from 'react'
import type { InstalledApp } from '../apps/types'

export function Dock({
	apps,
	openAppIds,
	onLaunch,
	onContextMenu
}: {
	apps: InstalledApp[]
	openAppIds: Set<string>
	onLaunch: (app: InstalledApp) => void
	onContextMenu: (event: ReactMouseEvent, app: InstalledApp) => void
}) {
	if (apps.length === 0) return null
	return (
		<div className="ds-dock-bar">
			<div className="ds-dock" role="toolbar" aria-label="Dock">
				{apps.map((app) => (
					<button
						key={app.id}
						type="button"
						className="ds-dock-item"
						title={app.description || app.name}
						aria-label={app.name}
						onClick={() => onLaunch(app)}
						onContextMenu={(event) => onContextMenu(event, app)}
					>
						<span className="ds-dock-icon">
							{app.iconUrl ? <img src={app.iconUrl} alt="" /> : app.name.slice(0, 1).toUpperCase()}
						</span>
						<span className="ds-dock-indicator" data-running={openAppIds.has(app.id)} />
					</button>
				))}
			</div>
		</div>
	)
}
