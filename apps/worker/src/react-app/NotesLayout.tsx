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
			<div className="safe-area-content flex min-h-full w-full flex-1 items-center justify-center px-6 py-10">
				<div className="max-w-md text-center font-sans">
					<p className="text-[0.65rem] font-medium uppercase tracking-[0.28em] text-base-content/25">
						Justfiles
					</p>
					<div className="mt-4 space-y-3">
						<p className="text-sm leading-6 text-base-content/45">
							Choose a file from the sidebar to open it here.
						</p>
						<p className="text-sm leading-6 text-base-content/35">
							If you just need a temporary place to write, use your scratch buffer.
						</p>
					</div>
					<div className="mt-5 flex items-center justify-center">
						<button
							type="button"
							onClick={() => navigate({ to: '/files/scratch', viewTransition: true })}
							className="btn btn-ghost btn-sm border-0 font-normal text-base-content/50 hover:bg-base-200 hover:text-base-content/70"
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
