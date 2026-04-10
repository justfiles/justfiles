import { useAuth } from '@clerk/clerk-react'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { FiChevronLeft, FiSearch, FiX } from 'react-icons/fi'
import { basename, normalizeVolumePath, parentVolumePath } from './assets'
import { applySharedHeaderActionPolicy } from './headerActionPolicy'
import { HeaderActionMenu } from './HeaderActionMenu'
import { MemoryEditor } from './MemoryEditor'
import { noteFilenameFromName, noteNameFromPath } from './notePath'
import { ModeSelector } from './ModeSelector'
import { useScratch } from './scratch'
import {
	type Destination,
	expandTemplate,
	getActiveDestination,
	loadSettings,
	saveSettings
} from './settings'

type FiledScratch = {
	id: string
	path: string
}

type FilingFormState = {
	destinationId: string
	folder: string
	name: string
}

function useOnlineStatus() {
	const [isOnline, setIsOnline] = useState(() => navigator.onLine)

	useEffect(() => {
		function syncOnlineState() {
			setIsOnline(navigator.onLine)
		}

		window.addEventListener('online', syncOnlineState)
		window.addEventListener('offline', syncOnlineState)

		return () => {
			window.removeEventListener('online', syncOnlineState)
			window.removeEventListener('offline', syncOnlineState)
		}
	}, [])

	return isOnline
}

function suggestedScratchPath(destination: Destination): string {
	return normalizeVolumePath(expandTemplate(destination.pathTemplate))
}

function createFilingForm(destination: Destination): FilingFormState {
	const path = suggestedScratchPath(destination)

	return {
		destinationId: destination.id,
		folder: parentVolumePath(path).slice(1),
		name: noteNameFromPath(path)
	}
}

function buildFiledPath(form: FilingFormState): string {
	const filename = noteFilenameFromName(form.name)
	return normalizeVolumePath(form.folder.trim() ? `${form.folder.trim()}/${filename}` : `/${filename}`)
}

function FilesBackButton() {
	const navigate = useNavigate()

	return (
		<button
			type="button"
			onClick={() => void navigate({ to: '/files', viewTransition: true })}
			className="btn btn-ghost btn-sm text-primary gap-0.5 -ml-1 sm:hidden"
		>
			<FiChevronLeft className="w-5 h-5" />
			Files
		</button>
	)
}

function ScratchFiledToast({ scratch, onOpen, onClose }: {
	scratch: FiledScratch
	onOpen: () => void
	onClose: () => void
}) {
	return (
		<div className="safe-area-toast fixed z-50 flex items-center gap-3 rounded-lg bg-base-300 px-4 py-3 shadow-lg text-sm">
			<div className="min-w-0">
				<p className="font-medium text-base-content">Scratch filed</p>
				<p className="truncate font-mono text-xs text-base-content/60">/{scratch.path}</p>
			</div>
			<button
				type="button"
				onClick={onOpen}
				className="btn btn-primary btn-xs"
			>
				Open file
			</button>
			<button
				type="button"
				onClick={onClose}
				className="btn btn-ghost btn-xs"
				aria-label="Dismiss filed scratch notice"
			>
				<FiX className="h-3.5 w-3.5" />
			</button>
		</div>
	)
}

function ScratchPage() {
	const { userId } = useAuth()
	const navigate = useNavigate()
	const [settings] = useState(() => loadSettings(userId!))
	const [activeDestination, setActiveDestination] = useState<Destination>(() =>
		getActiveDestination(settings)
	)
	const [isFilingDialogOpen, setIsFilingDialogOpen] = useState(false)
	const [showAdvancedOptions, setShowAdvancedOptions] = useState(false)
	const [filingForm, setFilingForm] = useState<FilingFormState>(() =>
		createFilingForm(getActiveDestination(settings))
	)
	const [filedScratch, setFiledScratch] = useState<FiledScratch | null>(null)
	const {
		id,
		isLoading,
		content,
		save,
		submit,
		uploadAsset,
		getAssetUrl,
		loadAssetBlob
	} = useScratch()
	const isOnline = useOnlineStatus()
	const dialogRef = useRef<HTMLDialogElement>(null)
	const formRef = useRef<HTMLFormElement>(null)
	const nameInputRef = useRef<HTMLInputElement>(null)
	const openFileDialogRef = useRef<() => void>(() => {})
	const submitFileDialogRef = useRef<() => void>(() => {})

	const fileScratchMutation = useMutation({
		mutationFn: async ({ path }: { path: string }) => {
			return submit(path)
		},
		onSuccess: (result) => {
			setFiledScratch(result)
			setIsFilingDialogOpen(false)
			setShowAdvancedOptions(false)
		}
	})

	function handleSelectDestination(destination: Destination) {
		setActiveDestination(destination)
		saveSettings({ lastUsedDestinationId: destination.id }, userId!)
	}

	function resetFilingForm(destination: Destination) {
		setFilingForm(createFilingForm(destination))
		setShowAdvancedOptions(false)
	}

	function openFilingDialog() {
		resetFilingForm(activeDestination)
		setIsFilingDialogOpen(true)
	}

	function closeFilingDialog() {
		setIsFilingDialogOpen(false)
	}

	function submitFilingDialog() {
		formRef.current?.requestSubmit()
	}

	openFileDialogRef.current = openFilingDialog
	submitFileDialogRef.current = submitFilingDialog

	useEffect(() => {
		const dialog = dialogRef.current
		if (!dialog) return

		if (isFilingDialogOpen && !dialog.open) {
			dialog.showModal()
			return
		}

		if (!isFilingDialogOpen && dialog.open) {
			dialog.close()
		}
	}, [isFilingDialogOpen])

	useEffect(() => {
		const dialog = dialogRef.current
		if (!dialog) return

		function onClose() {
			setIsFilingDialogOpen(false)
		}

		dialog.addEventListener('close', onClose)
		return () => dialog.removeEventListener('close', onClose)
	}, [])

	useEffect(() => {
		if (!isFilingDialogOpen) return
		requestAnimationFrame(() => {
			nameInputRef.current?.focus()
			nameInputRef.current?.select()
		})
	}, [isFilingDialogOpen])

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				if (isFilingDialogOpen) {
					submitFileDialogRef.current()
					return
				}
				openFileDialogRef.current()
			}
		}

		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [isFilingDialogOpen])

	function handleDialogDestinationChange(destinationId: string) {
		const destination = settings.destinations.find((candidate) => candidate.id === destinationId)
		if (!destination) return

		handleSelectDestination(destination)
		resetFilingForm(destination)
	}

	function handleFileScratch(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault()
		fileScratchMutation.mutate({
			path: buildFiledPath(filingForm)
		})
	}

	return (
		<>
			<MemoryEditor
				id={id}
				content={content}
				onSave={save}
				onUploadAsset={uploadAsset}
				resolveAssetUrl={getAssetUrl}
				readAssetBlob={loadAssetBlob}
				isLoading={isLoading}
				leadingControl={<FilesBackButton />}
				headerLeft={
					<div className="flex items-center gap-2 min-w-0">
						<span className="text-sm font-medium text-base-content/70 font-mono shrink-0">
							scratch{fileScratchMutation.isPending ? '*' : ''}
						</span>
						<ModeSelector
							destinations={settings.destinations}
							active={activeDestination}
							onSelect={handleSelectDestination}
						/>
					</div>
				}
				editorHeader={
						<div className="mb-1">
							<h1 className="text-[1.85rem] leading-tight font-semibold tracking-tight text-base-content/85">
								Scratch
							</h1>
						</div>
					}
				headerRight={
					<HeaderActionMenu
						surface="editor"
						items={[
							applySharedHeaderActionPolicy({
								key: 'search',
								label: 'Search',
								onClick: () => window.dispatchEvent(new Event('open-command-palette')),
								icon: <FiSearch className="w-3.5 h-3.5 shrink-0" />,
								shortcut: <kbd className="kbd kbd-xs hidden sm:inline">⌘K</kbd>,
								hideLabelOnMobile: true
							}, 'search', 'editor'),
								{
									key: 'file-scratch',
									label: fileScratchMutation.isPending ? 'Filing…' : 'File…',
									onClick: openFilingDialog,
									disabled: fileScratchMutation.isPending || !isOnline,
									tone: 'primary'
								}
						]}
					/>
				}
			/>

				<dialog ref={dialogRef} className="modal items-start pt-[12vh]">
					<div className="modal-box w-[min(560px,92vw)] max-w-none rounded-xl p-0">
						<form ref={formRef} onSubmit={handleFileScratch}>
							<div className="border-b border-base-200 px-6 py-4">
								<div className="flex items-start justify-between gap-4">
									<div>
										<h2 className="text-lg font-semibold text-base-content">File scratch</h2>
										<p className="mt-1 text-sm text-base-content/60">
											Give this scratch note a name. A fresh empty scratch will be created right after.
										</p>
									</div>
								<button
										type="button"
										onClick={closeFilingDialog}
										className="btn btn-ghost btn-sm btn-circle"
										aria-label="Close file scratch dialog"
									>
										<FiX className="h-4 w-4" />
									</button>
							</div>
						</div>

						<div className="space-y-4 px-6 py-5">
							<label className="block">
								<span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.18em] text-base-content/45">
									Name
								</span>
								<input
									ref={nameInputRef}
									type="text"
									value={filingForm.name}
										onChange={(e) => setFilingForm((current) => ({
											...current,
											name: e.target.value
										}))}
										placeholder={noteNameFromPath(suggestedScratchPath(activeDestination))}
										className="input input-bordered w-full font-medium"
										disabled={fileScratchMutation.isPending}
									/>
								</label>

							<div className="rounded-lg bg-base-200/70 px-3 py-2">
								<p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-base-content/45">
									Will be saved to
								</p>
								<p className="mt-1 truncate font-mono text-sm text-base-content/75">
									/{buildFiledPath(filingForm).slice(1)}
								</p>
							</div>

							<div>
								<button
									type="button"
									onClick={() => setShowAdvancedOptions((value) => !value)}
									className="text-xs font-mono text-base-content/55 transition-colors hover:text-base-content/80"
								>
									{showAdvancedOptions ? 'Hide options' : 'More options'}
								</button>
							</div>

							{showAdvancedOptions ? (
								<div className="grid gap-4 rounded-xl border border-base-200 bg-base-100 px-4 py-4 sm:grid-cols-2">
									<label className="block">
										<span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.18em] text-base-content/45">
											Destination
										</span>
										<select
											value={filingForm.destinationId}
											onChange={(e) => handleDialogDestinationChange(e.target.value)}
											className="select select-bordered w-full"
											disabled={fileScratchMutation.isPending}
										>
											{settings.destinations.map((destination) => (
												<option key={destination.id} value={destination.id}>
													{destination.name || basename(destination.pathTemplate) || 'Destination'}
												</option>
											))}
										</select>
									</label>

									<label className="block sm:col-span-2">
										<span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.18em] text-base-content/45">
											Folder
										</span>
										<input
											type="text"
											value={filingForm.folder}
											onChange={(e) => setFilingForm((current) => ({
												...current,
												folder: e.target.value
											}))}
											placeholder="inbox"
											spellCheck={false}
											className="input input-bordered w-full font-mono text-sm"
											disabled={fileScratchMutation.isPending}
										/>
									</label>
								</div>
							) : null}
						</div>

						<div className="flex items-center justify-end gap-3 border-t border-base-200 px-6 py-4">
								<button
									type="button"
									onClick={closeFilingDialog}
									className="btn btn-ghost"
									disabled={fileScratchMutation.isPending}
								>
									Cancel
								</button>
								<button
									type="submit"
									className="btn btn-primary"
									disabled={fileScratchMutation.isPending || !isOnline}
								>
									{fileScratchMutation.isPending ? 'Filing…' : 'File scratch'}
								</button>
							</div>
						</form>
				</div>

				<form method="dialog" className="modal-backdrop">
					<button type="button" onClick={closeFilingDialog}>Close</button>
				</form>
			</dialog>

			{filedScratch ? (
				<ScratchFiledToast
					scratch={filedScratch}
					onOpen={() => {
						void navigate({
							to: '/files/$id',
							params: { id: filedScratch.id },
							viewTransition: true
						})
						setFiledScratch(null)
					}}
					onClose={() => setFiledScratch(null)}
				/>
			) : null}
		</>
	)
}

export default ScratchPage
