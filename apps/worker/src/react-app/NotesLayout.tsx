import { UserButton } from '@clerk/clerk-react'
import { Outlet, useNavigate } from '@tanstack/react-router'
import { FiSettings } from 'react-icons/fi'
import { useLayoutMode } from './layoutMode'
import { Sidebar } from './Sidebar'
import { useVolume } from './useVolume'

function FilesListActions({ showAccount }: { showAccount: boolean }) {
	const navigate = useNavigate()

	return (
		<>
			{showAccount ? (
				<UserButton appearance={{ elements: { avatarBox: 'w-6 h-6' } }}>
					<UserButton.MenuItems>
						<UserButton.Action
							label="Settings"
							labelIcon={<FiSettings />}
							onClick={() => navigate({ to: '/settings' })}
						/>
					</UserButton.MenuItems>
				</UserButton>
			) : null}
		</>
	)
}

export function FilesIndexPage() {
	const navigate = useNavigate()

	return (
		<div className="hidden sm:flex flex-1 min-h-0 overflow-y-auto">
			<div className="safe-area-content flex min-h-full items-center justify-center px-6 py-10">
				<div className="max-w-sm text-center">
					<p className="text-xs font-mono uppercase tracking-[0.24em] text-base-content/35">
						Justfiles
					</p>
					<h1 className="mt-3 text-2xl font-semibold tracking-tight text-base-content/85">
						Choose a file
					</h1>
					<p className="mt-3 text-sm text-base-content/55">
						Select a file from the list, or jump back into your scratch buffer.
					</p>
					<div className="mt-6 flex items-center justify-center gap-3">
						<button
							type="button"
							onClick={() => navigate({ to: '/files/scratch', viewTransition: true })}
							className="btn btn-primary"
						>
							Open scratch
						</button>
					</div>
				</div>
			</div>
		</div>
	)
}

export function FilesLayout() {
	const { entries } = useVolume()
	const { showingFileDetail } = useLayoutMode()

	return (
		<div className="flex h-full min-h-0">
			<aside
				className={`${showingFileDetail ? 'hidden sm:flex' : 'flex'} min-h-0 w-full shrink-0 flex-col border-r border-base-300 bg-base-100 sm:w-72 md:w-80`}
			>
				<Sidebar
					entries={entries}
					headerActions={<FilesListActions showAccount={!showingFileDetail} />}
				/>
			</aside>
			<section
				className={`${showingFileDetail ? 'flex' : 'hidden sm:flex'} min-h-0 min-w-0 flex-1 flex-col`}
			>
				<Outlet />
			</section>
		</div>
	)
}
