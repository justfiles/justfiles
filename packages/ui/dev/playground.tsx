import '../../design/design.css'
import { type CSSProperties, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
	AttachedAgent,
	type AttachedAgentMode,
	type AttachedAgentSize
} from '../src/AttachedAgent.tsx'
import { Transcript, type TranscriptRow } from '../src/Transcript.tsx'

let panelMounts = 0

const messages: TranscriptRow[] = [
	{ id: 'question', role: 'user', content: 'Which synonym is closest?' },
	{
		id: 'activity',
		type: 'activity',
		label: '2 steps · 1.4s',
		items: [
			{ kind: 'think', durationMs: 400 },
			{ kind: 'tool', name: 'dictionary', label: 'Looking up perfunctory', durationMs: 1_000 }
		],
		detailId: 'activity-detail'
	},
	{
		id: 'answer',
		role: 'assistant',
		content: 'Token. Both mean the gesture was made only to have made it. Desultory means aimless.'
	},
	{ id: 'follow-up', role: 'user', content: 'What about cursory?' },
	{ id: 'follow-up-answer', role: 'assistant', content: 'Cursory means hurried or incomplete.' },
	{ id: 'last-question', role: 'user', content: 'And desultory?' },
	{
		id: 'expired-activity',
		type: 'activity',
		label: 'Read old note · 0.2s',
		items: [{ kind: 'tool', name: 'read', label: 'Reading an old note', durationMs: 200 }],
		detailId: 'expired-detail'
	},
	{ id: 'last-answer', role: 'assistant', content: 'Desultory means lacking a plan or purpose.' }
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
			<Transcript
				messages={messages}
				isStreaming={false}
				assistantStyle="plain"
				activity={{
					loadDetail: async (id) =>
						id === 'expired-detail'
							? { status: 'expired' }
							: {
									status: 'available',
									detail: {
										items: [
											{ kind: 'think', content: 'Token is the closest match in this sentence.' },
											{
												kind: 'tool',
												name: 'dictionary',
												input: { word: 'perfunctory' },
												result: { synonyms: ['token', 'cursory', 'desultory'] }
											}
										]
									}
								}
				}}
			/>
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
