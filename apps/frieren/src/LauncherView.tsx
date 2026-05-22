import type { InstalledApp } from './chat/types'

export function LauncherView(props: {
	apps: InstalledApp[]
	onLaunch: (app: InstalledApp) => void
	onInstallApp?: () => void
	onUninstallApp?: (id: string) => void
}) {
	const { apps, onLaunch, onInstallApp, onUninstallApp } = props

	return (
		<div className="h-full w-full overflow-x-auto bg-gradient-to-br from-sky-800 via-blue-950 to-slate-950 p-8 pt-10 text-sky-50">
			{onInstallApp ? (
				<div className="mb-6 flex justify-end">
					<button
						type="button"
						onClick={onInstallApp}
						className="rounded border border-white/30 bg-white/10 px-3 py-1 text-xs font-medium text-white hover:bg-white/20"
						title="Pick a directory containing manifest.json + app.js + gui.js"
					>
						+ Install app
					</button>
				</div>
			) : null}
			<div className="grid grid-cols-4 justify-start gap-x-10 gap-y-8">
				{apps.map((app) => {
					const canUninstall = app.kind === 'app' && !!onUninstallApp
					return (
						<div
							key={`${app.kind}:${app.id}`}
							className="group relative flex w-20 min-w-0 flex-col items-center gap-2 text-center"
						>
							<button
								type="button"
								className="flex w-full flex-col items-center gap-2 text-center"
								title={app.description || app.name}
								onClick={() => onLaunch(app)}
							>
								<span className="flex size-[68px] items-center justify-center overflow-hidden rounded-[16px] border border-white/30 bg-gradient-to-b from-sky-100 via-sky-300 to-blue-500 text-2xl font-semibold text-slate-950 shadow-[0_10px_24px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.85)] transition group-hover:-translate-y-0.5">
									{app.iconUrl ? (
										<img src={app.iconUrl} alt="" className="size-full object-cover" />
									) : (
										app.name.slice(0, 1).toUpperCase()
									)}
								</span>
								<span className="w-full truncate text-xs font-medium text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
									{app.name}
								</span>
							</button>
							{canUninstall ? (
								<button
									type="button"
									aria-label={`Uninstall ${app.name}`}
									title={`Uninstall ${app.name}`}
									onClick={(e) => {
										e.stopPropagation()
										if (confirm(`Uninstall "${app.name}"?`)) onUninstallApp?.(app.id)
									}}
									className="absolute -top-1 -right-1 hidden size-5 items-center justify-center rounded-full border border-white/40 bg-slate-900/90 text-xs leading-none text-white shadow hover:bg-red-600 group-hover:flex"
								>
									×
								</button>
							) : null}
						</div>
					)
				})}
			</div>
		</div>
	)
}
