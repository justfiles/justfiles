import '../../design/design.css'
import { type CSSProperties, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
	AttachedAgent,
	type AttachedAgentMode,
	type AttachedAgentSize
} from '../src/AttachedAgent.tsx'
import { type AgentMessage, Transcript } from '../src/Transcript.tsx'

let panelMounts = 0

const messages: AgentMessage[] = [
	{ id: 'question', role: 'user', content: 'Which synonym is closest?' },
	{
		id: 'answer',
		role: 'assistant',
		content: 'Token. Both mean the gesture was made only to have made it. Desultory means aimless.'
	}
]

type ThemeStyle = CSSProperties & Record<`--${string}`, string>

const themes: Record<'light' | 'dark', ThemeStyle> = {
	light: {
		'--surface': '#f5f5f4',
		'--window-bg': '#ffffff',
		'--text': '#1c1c1c',
		'--rule': '#d0d0cd',
		'--focus': '#0a84ff',
		'--control-bg': '#ffffff'
	},
	dark: {
		'--surface': '#2c2c2e',
		'--window-bg': '#1e1e1e',
		'--text': '#ebebf0',
		'--rule': '#3a3a3c',
		'--focus': '#0a84ff',
		'--control-bg': '#48484a'
	}
}

function FakePanel() {
	const [mount] = useState(() => ++panelMounts)
	const [draft, setDraft] = useState('')
	return (
		<div className="demo-panel">
			<div className="demo-panel-title">
				<span className="demo-app-icon">D</span>
				<span>Frieren · Dictionary</span>
			</div>
			<Transcript messages={messages} isStreaming={false} assistantStyle="plain" />
			<label className="demo-composer">
				<span>Draft · mount {mount}</span>
				<input
					data-testid="draft"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					placeholder="Ask about Dictionary"
				/>
			</label>
		</div>
	)
}

function FakeApp() {
	return (
		<div className="demo-app">
			<div className="demo-search">⌕ perfunctory · 1 entry</div>
			<h1>per·func·to·ry</h1>
			<em>adjective</em>
			<p>Done routinely and with little interest or care.</p>
			<p className="demo-similar">Similar: cursory · desultory · token · offhand</p>
		</div>
	)
}

function App() {
	const [mode, setMode] = useState<AttachedAgentMode>('sheet')
	const [open, setOpen] = useState(true)
	const [size, setSize] = useState<AttachedAgentSize>({ sheet: 280, sidebar: 300 })
	const [width, setWidth] = useState(760)
	const [focused, setFocused] = useState(true)
	const [theme, setTheme] = useState<keyof typeof themes>('light')

	return (
		<main className="demo" style={themes[theme]}>
			<nav className="demo-controls" aria-label="Attached agent playground controls">
				<button type="button" onClick={() => setOpen((value) => !value)}>
					{open ? 'Close' : 'Open'}
				</button>
				<button type="button" onClick={() => setMode(mode === 'sheet' ? 'sidebar' : 'sheet')}>
					Prefer {mode === 'sheet' ? 'sidebar' : 'sheet'}
				</button>
				<button type="button" onClick={() => setWidth(width === 760 ? 520 : 760)}>
					{width === 760 ? 'Narrow' : 'Wide'}
				</button>
				<button type="button" onClick={() => setFocused((value) => !value)}>
					{focused ? 'Deactivate' : 'Focus'}
				</button>
				<button type="button" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
					{theme === 'light' ? 'Dark' : 'Light'}
				</button>
				<output data-testid="state">
					{width}px · {mode} preferred · {theme} · {focused ? 'focused' : 'inactive'}
				</output>
			</nav>
			<div className="demo-stage">
				<section
					className="ds-window ds-window-framed demo-window"
					data-focused={focused}
					style={{ width }}
				>
					<header className="ds-window-titlebar">
						<span className="ds-window-controls">
							<i className="ds-window-control ds-window-control-close" />
							<i className="ds-window-control ds-window-control-fullscreen" />
						</span>
						<span className="ds-window-title">Dictionary</span>
						<span className="ds-window-spacer" />
					</header>
					<div className="ds-window-body">
						<AttachedAgent
							agent={{
								mode,
								open,
								size,
								footer: <span className="demo-face">•‿•</span>,
								panel: <FakePanel />,
								onModeChange: setMode,
								onOpenChange: setOpen,
								onSizeChange: setSize
							}}
						>
							<FakeApp />
						</AttachedAgent>
					</div>
				</section>
			</div>
		</main>
	)
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
