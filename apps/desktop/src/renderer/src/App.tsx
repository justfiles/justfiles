import { useEffect, useRef, useState } from 'react'
import type { LauncherApp } from '../../shared/kernel'

type GuiModule = {
	gui: {
		mount: (
			el: HTMLElement,
			state: unknown,
			ctx: {
				transport: {
					invoke: (message: unknown) => Promise<unknown>
					subscribe: (onState: (state: unknown) => void) => () => void
				}
			}
		) => { unmount?: () => void | Promise<void> }
	}
}

// Spotlight/Raycast-style launch bar: type to filter, arrow keys to move the
// selection, Enter (or click) opens the highlighted app in its own window.
function Launcher(): React.JSX.Element {
	const [apps, setApps] = useState<LauncherApp[]>([])
	const [query, setQuery] = useState('')
	const [selected, setSelected] = useState(0)
	const inputRef = useRef<HTMLInputElement>(null)
	const rootRef = useRef<HTMLDivElement>(null)

	const matches = query
		? apps.filter((app) => app.name.toLowerCase().includes(query.toLowerCase()))
		: apps

	useEffect(() => {
		void window.api.kernelList().then(setApps)
	}, [])

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
			window.api.openApp(matches[selected].id)
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
					{matches.map((app, i) => (
						<button
							key={app.id}
							type="button"
							className={i === selected ? 'item selected' : 'item'}
							onClick={() => window.api.openApp(app.id)}
						>
							{app.name}
						</button>
					))}
				</div>
			)}
		</div>
	)
}

function AppWindow({ id }: { id: string }): React.JSX.Element {
	const rootRef = useRef<HTMLDivElement>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		let disposed = false
		let cleanup: (() => void | Promise<void>) | undefined
		void (async () => {
			const state = await window.api.kernelState(id)
			const mod = (await import(/* @vite-ignore */ `app://${id}/gui.js`)) as GuiModule
			if (disposed || !rootRef.current) return
			const instance = mod.gui.mount(rootRef.current, state, {
				transport: {
					invoke: (message) => window.api.kernelDispatch(id, message),
					subscribe: (onState) => window.api.kernelSubscribe(id, onState)
				}
			})
			cleanup = instance.unmount
		})().catch((error) => setError(error instanceof Error ? error.message : String(error)))
		return () => {
			disposed = true
			void cleanup?.()
		}
	}, [id])

	return (
		<div className="app-host" ref={rootRef}>
			{error}
		</div>
	)
}

function App(): React.JSX.Element {
	const params = new URLSearchParams(window.location.search)
	const appId = params.get('appId')
	if (appId) return <AppWindow id={appId} />

	const app = params.get('app')
	if (app) {
		document.title = app
		return <div className="app-view">{app}</div>
	}
	return <Launcher />
}

export default App
