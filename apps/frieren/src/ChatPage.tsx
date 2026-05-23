import { UserButton } from '@clerk/clerk-react'
import { Menubar } from '@/components/Menubar'
import { Button } from '@/components/ui/button'
import { Window } from '@/components/Window'
import { BuiltinHost } from './BuiltinHost'
import { builtinLauncherEntries } from './builtin'
import type { ConnectionState, InstalledApp } from './chat/types'
import { useChat } from './chat/useChat'
import { navigate } from './clientRouter'
import { KernelAppFrame } from './KernelAppFrame'

const statusDotColor: Record<ConnectionState, string> = {
	ready: '#22c55e',
	connecting: '#f59e0b',
	disconnected: '#ef4444'
}

export function ChatPage() {
	const { connection, apps } = useChat()
	const { launcher } = apps
	const desktopApps: InstalledApp[] = [...launcher.installedApps, ...builtinLauncherEntries()]

	return (
		<div className="flex h-screen flex-col">
			<Menubar>
				<div className="flex items-center gap-1">
					<span className="font-medium">Frieren</span>
					<Button type="button" variant="ghost" size="sm" onClick={() => navigate('/files')}>
						Files
					</Button>
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
					<UserButton appearance={{ elements: { avatarBox: 'w-6 h-6' } }} />
				</div>
			</Menubar>

			<div
				className="relative flex flex-1 overflow-hidden"
				style={{ background: 'var(--desktop-bg)' }}
			>
				<div className="absolute top-4 right-4 flex flex-col gap-4">
					{desktopApps.map((app) => {
						const canUninstall = app.kind === 'app' && !!launcher.uninstallApp
						return (
							<div
								key={`${app.kind}:${app.id}`}
								className="group relative flex w-20 flex-col items-center"
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
								{canUninstall ? (
									<button
										type="button"
										aria-label={`Uninstall ${app.name}`}
										title={`Uninstall ${app.name}`}
										onClick={(event) => {
											event.stopPropagation()
											if (confirm(`Uninstall "${app.name}"?`)) void launcher.uninstallApp?.(app.id)
										}}
										className="absolute -top-1 right-2 hidden size-5 items-center justify-center rounded-full border border-white/40 bg-slate-900/90 text-xs leading-none text-white shadow hover:bg-red-600 group-hover:flex"
									>
										×
									</button>
								) : null}
							</div>
						)
					})}
				</div>
				{launcher.openApps.map((app, index) => {
					const key = `${app.kind}:${app.id}`
					const info = desktopApps.find((d) => d.kind === app.kind && d.id === app.id)
					const focused = launcher.focusedId === key
					return (
						<Window
							key={key}
							title={info?.name ?? ''}
							onClose={launcher.close}
							onFocus={() => launcher.focus(app)}
							focused={focused}
							zIndex={index + 1}
							initialOffset={index * 24}
						>
							{app.kind === 'builtin' ? (
								<BuiltinHost id={app.id} />
							) : (
								<KernelAppFrame id={app.id} />
							)}
						</Window>
					)
				})}
			</div>
		</div>
	)
}
