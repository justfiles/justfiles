import '@justfiles/app/client'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

type CounterView = { count?: number }

function Counter() {
	const [view, setView] = useState<CounterView>((window.app.state as CounterView) ?? {})
	useEffect(() => window.app.subscribe((s) => setView((s as CounterView) ?? {})), [])

	const dispatch = (type: string) => window.app.dispatch({ type, payload: {} })

	return (
		<main className="counter">
			<h1>Counter</h1>
			<output>{view.count ?? '—'}</output>
			<div>
				<button type="button" onClick={() => dispatch('decrement')}>
					-
				</button>
				<button type="button" onClick={() => dispatch('increment')}>
					+
				</button>
				<button type="button" onClick={() => dispatch('reset')}>
					Reset
				</button>
			</div>
		</main>
	)
}

const root = document.getElementById('root')
if (root)
	createRoot(root).render(
		<StrictMode>
			<Counter />
		</StrictMode>
	)
