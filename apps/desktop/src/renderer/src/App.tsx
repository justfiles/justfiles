import { useEffect, useRef, useState } from 'react'
import { APPS } from '../../shared/apps'

// Spotlight/Raycast-style launch bar: type to filter, arrow keys to move the
// selection, Enter (or click) opens the highlighted app in its own window.
function Launcher(): React.JSX.Element {
	const [query, setQuery] = useState('')
	const [selected, setSelected] = useState(0)
	const inputRef = useRef<HTMLInputElement>(null)
	const rootRef = useRef<HTMLDivElement>(null)

	// Empty query shows just the search bar — no candidate list.
	const matches = query
		? APPS.filter((name) => name.toLowerCase().includes(query.toLowerCase()))
		: []

	// Grow/shrink the window to fit the content, Raycast-style.
	useEffect(() => {
		const el = rootRef.current
		if (!el) return
		const observer = new ResizeObserver(() =>
			window.api.resizeLauncher(el.getBoundingClientRect().height)
		)
		observer.observe(el)
		return () => observer.disconnect()
	}, [])

	// Refocus and reset every time the launcher window is summoned.
	useEffect(() => {
		const reset = (): void => {
			setQuery('')
			setSelected(0)
			inputRef.current?.focus()
		}
		reset()
		window.addEventListener('focus', reset)
		return () => window.removeEventListener('focus', reset)
	}, [])

	const onKeyDown = (e: React.KeyboardEvent): void => {
		if (e.key === 'ArrowDown') {
			e.preventDefault()
			setSelected((i) => Math.min(i + 1, matches.length - 1))
		} else if (e.key === 'ArrowUp') {
			e.preventDefault()
			setSelected((i) => Math.max(i - 1, 0))
		} else if (e.key === 'Enter' && matches[selected]) {
			window.api.openApp(matches[selected])
		}
	}

	return (
		<div className="launcher" ref={rootRef}>
			<input
				ref={inputRef}
				className="search"
				aria-label="Search apps"
				placeholder="Search apps…"
				value={query}
				onChange={(e) => {
					setQuery(e.target.value)
					setSelected(0)
				}}
				onKeyDown={onKeyDown}
			/>
			{matches.length > 0 && (
				<div className="results">
					{matches.map((name, i) => (
						<button
							key={name}
							type="button"
							className={i === selected ? 'item selected' : 'item'}
							onClick={() => window.api.openApp(name)}
						>
							{name}
						</button>
					))}
				</div>
			)}
		</div>
	)
}

function App(): React.JSX.Element {
	// Same renderer, two views: ?app=<name> is the app-window placeholder.
	const app = new URLSearchParams(window.location.search).get('app')
	if (app) {
		document.title = app
		return <div className="app-view">{app}</div>
	}
	return <Launcher />
}

export default App
