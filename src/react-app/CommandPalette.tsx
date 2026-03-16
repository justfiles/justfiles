import { useAuth } from '@clerk/clerk-react'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

type SearchResult = {
	memory_id: string
	path: string
	title?: string | null
	score: number
	semanticScore?: number
	ftsScore?: number
	snippet: string | null
	occurred_at: string | null
	source?: string
}

type RecentResult = {
	id: string
	path: string
	title: string | null
	tags: string[]
	updated_at: string
}

export function CommandPalette() {
	const { getToken } = useAuth()
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const [results, setResults] = useState<SearchResult[]>([])
	const [recentResults, setRecentResults] = useState<RecentResult[]>([])
	const [searching, setSearching] = useState(false)
	const [selectedIndex, setSelectedIndex] = useState(-1)
	const dialogRef = useRef<HTMLDialogElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const selectedRef = useRef<HTMLAnchorElement>(null)
	const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken

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
			getTokenRef.current().then((token) => {
				if (!token) return
				fetch('/api/v1/recent?n=5', {
					headers: { Authorization: `Bearer ${token}` }
				})
					.then((r) => r.json())
					.then((data: { results: RecentResult[] }) => setRecentResults(data.results))
					.catch(() => {})
			})
		} else {
			dialogRef.current?.close()
			setQuery('')
			setResults([])
			setRecentResults([])
			setSelectedIndex(-1)
		}
	}, [open])

	useEffect(() => {
		setSelectedIndex(-1)
	}, [results])

	useEffect(() => {
		if (!query.trim()) {
			setResults([])
			return
		}
		if (debounceTimer.current) clearTimeout(debounceTimer.current)
		debounceTimer.current = setTimeout(async () => {
			setSearching(true)
			try {
				const token = await getTokenRef.current()
				if (!token) return
				const isPath = query.startsWith('/') && !query.includes(' ')
				let results: SearchResult[]
				if (isPath) {
					const res = await fetch('/api/v1/list', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
						body: JSON.stringify({ path_prefix: query.replace(/^\//, '') })
					})
					const data = (await res.json()) as { results: { id: string; path: string; title: string | null; occurred_at: string | null; source: string | null }[] }
					results = data.results.map((r) => ({
						memory_id: r.id,
						path: r.path,
						title: r.title,
						score: 0,
						snippet: null,
						occurred_at: r.occurred_at,
						source: r.source ?? undefined
					}))
				} else {
					const res = await fetch('/api/v1/search', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
						body: JSON.stringify({ query })
					})
					const data = (await res.json()) as { results: SearchResult[] }
					results = data.results
				}
				setResults(results)
			} catch {
				setResults([])
			} finally {
				setSearching(false)
			}
		}, 300)
	}, [query])

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
							selectedRef.current?.click()
						}
					}}
				/>
				{searching && (
					<p className="m-0 px-4 py-2.5 text-base-content/50 text-sm">Searching…</p>
				)}
				{!searching && query && results.length === 0 && (
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
					<span><kbd className="kbd kbd-xs">↵</kbd> open</span>
					<span><kbd className="kbd kbd-xs">esc</kbd> close</span>
				</div>
			</div>
			<form method="dialog" className="modal-backdrop">
				<button>close</button>
			</form>
		</dialog>
	)
}
