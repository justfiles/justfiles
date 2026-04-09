import { Link } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { noteFilenameFromPath } from './notePath'
import { searchPaths } from './search'
import type { FileMeta } from './types'
import { useVolume } from './useVolume'

const RECENT_LIMIT = 5

type PaletteResult = {
	id: string
	path: string
	snippet: string | null
}

export function CommandPalette() {
	const { entries } = useVolume()
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const [submittedQuery, setSubmittedQuery] = useState('')
	const [selectedIndex, setSelectedIndex] = useState(-1)
	const dialogRef = useRef<HTMLDialogElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const selectedRef = useRef<HTMLAnchorElement>(null)

	useEffect(() => {
		if (!query.trim()) return
		const timeout = setTimeout(() => {
			setSubmittedQuery(query.trim())
			setSelectedIndex(-1)
		}, 200)
		return () => clearTimeout(timeout)
	}, [query])

	useEffect(() => {
		if (!query) {
			setSubmittedQuery('')
			setSelectedIndex(-1)
		}
	}, [query])

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault()
				setOpen((current) => !current)
			}
		}

		function onOpen() {
			setOpen(true)
		}

		window.addEventListener('keydown', onKeyDown)
		window.addEventListener('open-command-palette', onOpen)

		return () => {
			window.removeEventListener('keydown', onKeyDown)
			window.removeEventListener('open-command-palette', onOpen)
		}
	}, [])

	useEffect(() => {
		const dialog = dialogRef.current

		function onClose() {
			setOpen(false)
		}

		dialog?.addEventListener('close', onClose)
		return () => dialog?.removeEventListener('close', onClose)
	}, [])

	useEffect(() => {
		if (open) {
			dialogRef.current?.showModal()
			setTimeout(() => inputRef.current?.focus(), 0)
			return
		}

		dialogRef.current?.close()
		setQuery('')
		setSubmittedQuery('')
		setSelectedIndex(-1)
	}, [open])

	const recentResults = useMemo(
		() =>
			entries
				.filter((entry) => entry.active !== 0)
				.slice()
				.sort((left: FileMeta, right: FileMeta) => right.updated_at.localeCompare(left.updated_at))
				.slice(0, RECENT_LIMIT)
				.map((entry: FileMeta) => ({
					id: entry.id,
					path: entry.path,
					snippet: null
				} satisfies PaletteResult)),
		[entries]
	)

	const results = useMemo(() => {
		const trimmed = submittedQuery.trim()
		if (!trimmed) return []

		return searchPaths(entries, trimmed).map((entry: FileMeta) => ({
			id: entry.id,
			path: entry.path,
			snippet: null
		} satisfies PaletteResult))
	}, [entries, submittedQuery])

	const hasSubmitted = submittedQuery.trim().length > 0
	const hasSelection = selectedIndex >= 0

	return (
		<dialog ref={dialogRef} className="modal items-start pt-[12vh]">
			<div className="modal-box w-[min(600px,90vw)] max-w-none p-0 rounded-xl font-mono overflow-hidden">
				<input
					ref={inputRef}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search paths…"
					className="input w-full border-b border-base-200 rounded-none px-4 py-3.5 text-base bg-transparent font-mono outline-none"
					onKeyDown={(event) => {
						if (event.key === 'ArrowDown') {
							event.preventDefault()
							const length = query ? results.length : recentResults.length
							setSelectedIndex((current) => Math.min(current + 1, length - 1))
						} else if (event.key === 'ArrowUp') {
							event.preventDefault()
							setSelectedIndex((current) => Math.max(current - 1, -1))
						} else if (event.key === 'Enter') {
							event.preventDefault()
							if (hasSelection) {
								selectedRef.current?.click()
							} else if (query.trim()) {
								setSubmittedQuery(query.trim())
								setSelectedIndex(-1)
							}
						}
					}}
				/>
				{hasSubmitted && results.length === 0 && (
					<p className="m-0 px-4 py-2.5 text-base-content/50 text-sm">No results</p>
				)}
				{!query && recentResults.length > 0 && (
					<>
						<p className="m-0 px-4 pt-2.5 pb-1 text-xs text-base-content/40 uppercase tracking-wide">
							Recent
						</p>
						<ul className="m-0 py-1 list-none max-h-[50vh] overflow-y-auto">
							{recentResults.map((result: PaletteResult, index: number) => (
								<li key={result.id}>
									<Link
										ref={index === selectedIndex ? selectedRef : undefined}
										to="/files/$id"
										params={{ id: result.id }}
										viewTransition
										className={`block px-4 py-2.5 no-underline text-inherit cursor-pointer ${index === selectedIndex ? 'bg-base-200' : 'hover:bg-base-200'}`}
										onClick={() => setOpen(false)}
									>
											<div className="flex items-baseline justify-between gap-3">
												<span className="text-sm text-base-content truncate">
													{noteFilenameFromPath(result.path)}
												</span>
												<span className="text-xs text-base-content/40 shrink-0 truncate max-w-[40%]">
													/{result.path}
												</span>
											</div>
									</Link>
								</li>
							))}
						</ul>
					</>
				)}
				{query && results.length > 0 && (
					<ul className="m-0 py-1.5 list-none max-h-[50vh] overflow-y-auto">
						{results.map((result: PaletteResult, index: number) => (
							<li key={result.id}>
								<Link
									ref={index === selectedIndex ? selectedRef : undefined}
									to="/files/$id"
									params={{ id: result.id }}
									viewTransition
									className={`block px-4 py-2.5 no-underline text-inherit cursor-pointer ${index === selectedIndex ? 'bg-base-200' : 'hover:bg-base-200'}`}
									onClick={() => setOpen(false)}
									>
										<div className="flex items-baseline justify-between gap-3">
											<span className="text-sm text-base-content truncate">
												{noteFilenameFromPath(result.path)}
											</span>
											<span className="text-xs text-base-content/40 shrink-0 truncate max-w-[40%]">
												/{result.path}
											</span>
										</div>
									{result.snippet && (
										<div className="mt-0.5 text-xs text-base-content/60 whitespace-pre-wrap">
											{result.snippet}
										</div>
									)}
								</Link>
							</li>
						))}
					</ul>
				)}
				<div className="px-4 py-2 border-t border-base-200 flex gap-3 text-xs text-base-content/40 items-center">
					<span>
						<kbd className="kbd kbd-xs">↑</kbd>
						<kbd className="kbd kbd-xs">↓</kbd> navigate
					</span>
					<span>
						<kbd className="kbd kbd-xs">↵</kbd> {hasSelection ? 'open' : 'search'}
					</span>
					<span>
						<kbd className="kbd kbd-xs">esc</kbd> close
					</span>
				</div>
			</div>
			<form method="dialog" className="modal-backdrop">
				<button>close</button>
			</form>
		</dialog>
	)
}
