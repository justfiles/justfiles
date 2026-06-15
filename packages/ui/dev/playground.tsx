// Dev playground for @justfiles/ui. Renders the real components against ad-hoc
// state so they can be developed in isolation with HMR. Add demos by importing
// another component below and dropping it into <App/>.
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type AgentMessage, Transcript } from '../src/Transcript.tsx'

const LOREM =
	'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. ' +
	'How vexingly quick daft zebras jump! Sphinx of black quartz, judge my vow. '

function block(n: number): string {
	let s = ''
	for (let i = 0; i < n; i++) s += LOREM
	return s.trim()
}

function App() {
	const [messages, setMessages] = useState<AgentMessage[]>([])
	const [isStreaming, setIsStreaming] = useState(false)
	const idRef = useRef(0)
	const nextId = () => `m${idRef.current++}`

	// Append a finished user+assistant exchange (the "new message lands" case).
	const addBlock = () => {
		setMessages((m) => [
			...m,
			{ id: nextId(), role: 'user', content: `Question ${m.length}` },
			{ id: nextId(), role: 'assistant', content: block(2 + Math.floor(Math.random() * 4)) }
		])
	}

	// Simulate token streaming: push an empty assistant bubble, then grow it in
	// chunks. This is the case that was scrolling off-screen.
	const stream = () => {
		if (isStreaming) return
		const id = nextId()
		setMessages((m) => [...m, { id, role: 'assistant', content: '' }])
		setIsStreaming(true)
		const words = block(8).split(' ')
		let i = 0
		const tick = () => {
			// Big chunk (>32px tall) to exercise the mid-stream detach race.
			i = Math.min(words.length, i + 12)
			const content = words.slice(0, i).join(' ')
			setMessages((m) => m.map((x) => (x.id === id ? { ...x, content } : x)))
			if (i < words.length) setTimeout(tick, 250)
			else setIsStreaming(false)
		}
		setTimeout(tick, 250)
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
			<div style={{ display: 'flex', gap: 8, padding: 12, borderBottom: '1px solid var(--rule)' }}>
				<button type="button" onClick={addBlock} data-testid="add">
					Add block
				</button>
				<button type="button" onClick={stream} data-testid="stream">
					Stream
				</button>
				<button type="button" onClick={() => setMessages([])} data-testid="reset">
					Reset
				</button>
				<span data-testid="count" style={{ alignSelf: 'center', opacity: 0.6 }}>
					{messages.length} msgs {isStreaming ? '· streaming' : ''}
				</span>
			</div>
			<div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
				<Transcript messages={messages} isStreaming={isStreaming} />
			</div>
		</div>
	)
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
