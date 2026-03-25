import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { RecentResult, SearchResult } from '@ghostore/core'
import { useApiClient } from './useApiClient'

export function CommandPalette() {
	const api = useApiClient()
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const [submittedQuery, setSubmittedQuery] = useState('')
	const [selectedIndex, setSelectedIndex] = useState(-1)
	const dialogRef = useRef<HTMLDialogElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const selectedRef = useRef<HTMLAnchorElement>(null)

	const isPathQuery = (q: string) => q.startsWith('/') && !q.includes(' ')

	// Live search only for path queries (cheap SQLite list)
	useEffect(() => {
		if (!isPathQuery(query)) return
		const t = setTimeout(() => {
			setSubmittedQuery(query)
			setSelectedIndex(-1)
		}, 200)
		return () => clearTimeout(t)
	}, [query])

	// Clear submitted query when input is cleared
	useEffect(() => {
		if (!query) {
			setSubmittedQuery('')
			setSelectedIndex(-1)
		}
	}, [query])

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				setOpen((o) => !o)
			}
		}
		function onOpen() { setOpen(true) }
		window.addEventListener('keydown', onKeyDown)
		window.addEventListener('open-command-palette', onOpen)
		return () => {
			window.removeEventListener('keydown', onKeyDown)
			window.removeEventListener('open-command-palette', onOpen)
		}
	}, [])

	// sync state when dialog is closed natively (ESC key)
	useEffect(() => {
		const dialog = dialogRef.current
		function onClose() { setOpen(false) }
		dialog?.addEventListener('close', onClose)
		return () => dialog?.removeEventListener('close', onClose)
	}, [])

	useEffect(() => {
		if (open) {
			dialogRef.current?.showModal()
			setTimeout(() => inputRef.current?.focus(), 0)
		} else {
			dialogRef.current?.close()
			setQuery('')
			setSubmittedQuery('')
			setSelectedIndex(-1)
		}
	}, [open])

	const recentQuery = useQuery({
		queryKey: ['recent'],
		queryFn: async () => {
			const r = await api.v1.recent.$get({ query: { n: '5' } })
			const data = await r.json()
			return data.results as RecentResult[]
		},
		enabled: open,
		staleTime: 30_000,
	})

	const searchQuery = useQuery({
		queryKey: ['search', submittedQuery],
		queryFn: async () => {
			if (isPathQuery(submittedQuery)) {
				const res = await api.v1.list.$post({
					json: { path_prefix: submittedQuery.replace(/^\//, '') },
				})
				const data = await res.json()
				return data.results.map((r) => ({
					memory_id: r.id,
					path: r.path,
					title: r.title,
					score: 0,
					snippet: null,
					source: r.source ?? undefined,
				})) as SearchResult[]
			}
			const res = await api.v1.search.$post({ json: { query: submittedQuery } })
			const data = await res.json()
			return data.results as SearchResult[]
		},
		enabled: !!submittedQuery.trim(),
		staleTime: 30_000,
	})

	const results = searchQuery.data ?? []
	const recentResults = recentQuery.data ?? []
	const searching = searchQuery.isFetching
	const hasSubmitted = !!submittedQuery.trim()
	const hasSelection = selectedIndex >= 0

	return (
		<dialog ref={dialogRef} className="modal items-start pt-[12vh]">
			<div className="modal-box w-[min(600px,90vw)] max-w-none p-0 rounded-xl font-mono overflow-hidden">
				<input
					ref={inputRef}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search memories…"
					className="input w-full border-b border-base-200 rounded-none px-4 py-3.5 text-base bg-transparent font-mono outline-none"
					onKeyDown={(e) => {
						if (e.key === 'ArrowDown') {
							e.preventDefault()
							const len = query ? results.length : recentResults.length
							setSelectedIndex((i) => Math.min(i + 1, len - 1))
						} else if (e.key === 'ArrowUp') {
							e.preventDefault()
							setSelectedIndex((i) => Math.max(i - 1, -1))
						} else if (e.key === 'Enter') {
							e.preventDefault()
							if (hasSelection) {
								selectedRef.current?.click()
							} else if (query.trim() && !isPathQuery(query)) {
								setSubmittedQuery(query.trim())
								setSelectedIndex(-1)
							}
						}
					}}
				/>
				{searching && (
					<p className="m-0 px-4 py-2.5 text-base-content/50 text-sm">Searching…</p>
				)}
				{!searching && hasSubmitted && results.length === 0 && (
					<p className="m-0 px-4 py-2.5 text-base-content/50 text-sm">No results</p>
				)}
				{!query && recentResults.length > 0 && (
					<>
						<p className="m-0 px-4 pt-2.5 pb-1 text-xs text-base-content/40 uppercase tracking-wide">Recent</p>
						<ul className="m-0 py-1 list-none max-h-[50vh] overflow-y-auto">
							{recentResults.map((r, i) => (
								<li key={r.id}>
									<Link
										ref={i === selectedIndex ? selectedRef : undefined}
										to="/memory/$id"
										params={{ id: r.id }}
										className={`block px-4 py-2.5 no-underline text-inherit cursor-pointer ${i === selectedIndex ? 'bg-base-200' : 'hover:bg-base-200'}`}
										onClick={() => setOpen(false)}
									>
										<div className="flex items-baseline justify-between gap-3">
											<span className="text-sm text-base-content truncate">{r.title}</span>
											<span className="text-xs text-base-content/40 shrink-0 truncate max-w-[40%]">{r.path}</span>
										</div>
									</Link>
								</li>
							))}
						</ul>
					</>
				)}
				{query && results.length > 0 && (
					<ul className="m-0 py-1.5 list-none max-h-[50vh] overflow-y-auto">
						{results.map((r, i) => (
							<li key={r.memory_id}>
								<Link
									ref={i === selectedIndex ? selectedRef : undefined}
									to="/memory/$id"
									params={{ id: r.memory_id }}
									className={`block px-4 py-2.5 no-underline text-inherit cursor-pointer ${i === selectedIndex ? 'bg-base-200' : 'hover:bg-base-200'}`}
									onClick={() => setOpen(false)}
								>
									<div className="flex items-baseline justify-between gap-3">
										<span className="text-sm text-base-content truncate">{r.title}</span>
										<span className="text-xs text-base-content/40 shrink-0 truncate max-w-[40%]">{r.path}</span>
									</div>
									{r.snippet && <div className="mt-0.5 text-xs text-base-content/60 whitespace-pre-wrap">{r.snippet}</div>}
								</Link>
							</li>
						))}
					</ul>
				)}
				<div className="px-4 py-2 border-t border-base-200 flex gap-3 text-xs text-base-content/40 items-center">
					<span><kbd className="kbd kbd-xs">↑</kbd><kbd className="kbd kbd-xs">↓</kbd> navigate</span>
					<span><kbd className="kbd kbd-xs">↵</kbd> {hasSelection ? 'open' : 'search'}</span>
					<span><kbd className="kbd kbd-xs">esc</kbd> close</span>
				</div>
			</div>
			<form method="dialog" className="modal-backdrop">
				<button>close</button>
			</form>
		</dialog>
	)
}
