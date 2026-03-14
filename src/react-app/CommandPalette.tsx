import { useAuth } from '@clerk/clerk-react'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

type SearchResult = {
	memory_id: string
	path: string
	score: number
	semanticScore?: number
	ftsScore?: number
	snippet: string | null
	occurred_at: string | null
	source?: string
}

export function CommandPalette() {
	const { getToken } = useAuth()
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const [results, setResults] = useState<SearchResult[]>([])
	const [searching, setSearching] = useState(false)
	const inputRef = useRef<HTMLInputElement>(null)
	const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				setOpen((o) => !o)
			}
			if (e.key === 'Escape') setOpen(false)
		}
		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [])

	useEffect(() => {
		if (open) {
			setTimeout(() => inputRef.current?.focus(), 0)
		} else {
			setQuery('')
			setResults([])
		}
	}, [open])

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
						score: 0,
						snippet: r.title,
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
		}, 1000)
	}, [query])

	if (!open) return null

	return (
		<div
			className="fixed inset-0 bg-base-content/40 flex items-start justify-center pt-[12vh] z-50"
			onClick={() => setOpen(false)}
		>
			<div
				className="w-[min(600px,90vw)] bg-base-100 border border-base-200 rounded-xl shadow-2xl overflow-hidden font-mono"
				onClick={(e) => e.stopPropagation()}
			>
				<input
					ref={inputRef}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search memories…"
					className="input w-full border-b border-base-200 rounded-none px-4 py-3.5 text-base bg-transparent font-mono outline-none"
				/>
				{searching && (
					<p className="m-0 px-4 py-2.5 text-base-content/50 text-sm">Searching…</p>
				)}
				{!searching && query && results.length === 0 && (
					<p className="m-0 px-4 py-2.5 text-base-content/50 text-sm">No results</p>
				)}
				{results.length > 0 && (
					<ul className="m-0 py-1.5 list-none max-h-[50vh] overflow-y-auto">
						{results.map((r) => (
							<li key={r.memory_id}>
								<Link
									to="/memory/$id"
									params={{ id: r.memory_id }}
									className="block px-4 py-2.5 no-underline text-inherit hover:bg-base-200 cursor-pointer"
									onClick={() => setOpen(false)}
								>
									<div className="text-xs text-base-content/50">{r.path}</div>
									<div className="mt-0.5 text-base-content whitespace-pre-wrap">{r.snippet || <i>No snippet</i>}</div>
								</Link>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	)
}
