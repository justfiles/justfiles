import { SignInButton, SignUpButton, UserButton, useAuth } from '@clerk/clerk-react'
import { useState } from 'react'
import './App.css'

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

type Memory = {
	id: string
	scope: string
	title: string | null
	raw_text: string
	path: string
	occurred_at: string | null
	source: string | null
	created_at: string
	updated_at: string
	tags: string[]
	links: unknown[]
}

function App() {
	const { getToken, isLoaded, isSignedIn } = useAuth()
	const [query, setQuery] = useState('')
	const [results, setResults] = useState<SearchResult[]>([])
	const [searching, setSearching] = useState(false)
	const [loadingMemory, setLoadingMemory] = useState(false)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [selectedMemory, setSelectedMemory] = useState<SearchResult | null>(null)
	const [editorText, setEditorText] = useState('')
	const [submitStatus, setSubmitStatus] = useState<string | null>(null)

	if (!isLoaded) {
		return <p style={loadingStyle}>Loading…</p>
	}

	if (!isSignedIn) {
		return <AuthWall />
	}

	async function callWithAuth(
		input: string,
		init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {}
	): Promise<Response> {
		const token = await getToken()
		if (!token) throw new Error('Missing auth token')
		return fetch(input, {
			...init,
			headers: {
				...init.headers,
				Authorization: `Bearer ${token}`
			}
		})
	}

	async function handleSearch(e: React.FormEvent) {
		e.preventDefault()
		if (!query.trim()) return
		setSearching(true)
		setErrorMessage(null)
		try {
			const res = await callWithAuth('/api/v1/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ query })
			})
			const data = (await res.json()) as { results: SearchResult[] }
			setResults(data.results)
		} catch {
			setErrorMessage('Error searching memories')
			setResults([])
		} finally {
			setSearching(false)
		}
	}

	async function handleOpen(memory: SearchResult) {
		setErrorMessage(null)
		setLoadingMemory(true)
		setSubmitStatus(null)
		try {
			const res = await callWithAuth(`/api/v1/memory/${encodeURIComponent(memory.memory_id)}`)
			const data = (await res.json()) as Memory
			setSelectedMemory(memory)
			setEditorText(data.raw_text)
			setSubmitStatus('Loaded full memory')
		} catch {
			setErrorMessage('Error loading full memory')
		} finally {
			setLoadingMemory(false)
		}
	}

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault()
		if (!editorText.trim()) return
		setSubmitStatus(null)
		setErrorMessage(null)
		try {
			const res = await callWithAuth('/api/v1/capture', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: editorText })
			})
			const data = (await res.json()) as { id: string }
			setSubmitStatus(`Saved as memory ${data.id}`)
		} catch {
			setErrorMessage('Error saving memory')
		}
	}

	return (
		<div style={pageStyle}>
			<header style={headerStyle}>
				<div>
					<h1 style={{ margin: 0, fontWeight: 500 }}>Ghostore</h1>
					<p style={{ margin: 0, color: '#64748b' }}>Two-pane memory workspace</p>
				</div>
				<UserButton />
			</header>

			<div style={workspaceStyle}>
				<section style={sidebarStyle}>
					<form onSubmit={handleSearch} style={searchRowStyle}>
						<input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search memories..."
							style={searchInputStyle}
						/>
						<button type="submit" disabled={searching} style={buttonStyle}>
							{searching ? 'Searching…' : 'Search'}
						</button>
					</form>

					<div style={resultsWrapStyle}>
						{results.length === 0 && !searching && !query && (
							<p style={{ margin: '0', color: '#64748b', fontSize: '0.85rem' }}>Search to load memories.</p>
						)}
						{results.length === 0 && !searching && query && (
							<p style={{ margin: '0', color: '#64748b', fontSize: '0.85rem' }}>No matching memories.</p>
						)}
						{results.length > 0 && (
							<ul style={resultsListStyle}>
								{results.map((r) => (
									<li key={r.memory_id}>
										<button
										type="button"
										onClick={() => handleOpen(r)}
										style={resultButtonStyle(selectedMemory?.memory_id === r.memory_id)}
										disabled={loadingMemory && selectedMemory?.memory_id === r.memory_id}
									>
										<div style={{ fontSize: '0.75rem', color: '#64748b' }}>{r.path}</div>
										<div style={{ fontSize: '0.7rem', color: '#475569', marginTop: '0.2rem', whiteSpace: 'pre-wrap' }}>
											{`score: ${r.score.toFixed(3)}`}
											{r.semanticScore !== undefined ? ` · semantic: ${r.semanticScore.toFixed(3)}` : ''}
											{r.ftsScore !== undefined ? ` · fts: ${r.ftsScore.toFixed(3)}` : ''}
										</div>
										<div style={{ marginTop: '0.35rem', color: '#0f172a', whiteSpace: 'pre-wrap' }}>
											{r.snippet || <i>No snippet</i>}
										</div>
									</button>
								</li>
								))}
							</ul>
						)}
					</div>
				</section>

				<section style={editorPaneStyle}>
					<form onSubmit={handleSubmit} style={editorFormStyle}>
						<div style={editorHeaderStyle}>
							<h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 500 }}>Editor</h2>
							{selectedMemory ? (
								<div style={{ color: '#64748b', fontSize: '0.8rem' }}>{selectedMemory.path}</div>
							) : (
								<div style={{ color: '#64748b', fontSize: '0.8rem' }}>No memory selected</div>
							)}
						</div>
						<textarea
							value={editorText}
							onChange={(e) => setEditorText(e.target.value)}
							placeholder="Write a new memory and submit"
							style={editorTextStyle}
						/>
						<div style={editorFooterStyle}>
							<button type="submit" style={buttonStyle}>
								Submit
							</button>
							{submitStatus && <span style={{ color: '#16a34a', fontSize: '0.82rem' }}>{submitStatus}</span>}
						</div>
					</form>
				</section>
			</div>

			{errorMessage && <p style={{ color: '#dc2626', marginTop: '0.75rem' }}>{errorMessage}</p>}
		</div>
	)
}

function AuthWall() {
	return (
		<div style={authShellStyle}>
			<div style={authCardStyle}>
				<h1 style={{ margin: 0 }}>Ghostore</h1>
				<p style={{ marginBottom: '1rem' }}>Sign in or create an account to access your memories.</p>
				<div style={{ display: 'flex', justifyContent: 'center', gap: '0.75rem' }}>
					<SignInButton />
					<SignUpButton />
				</div>
			</div>
		</div>
	)
}

const loadingStyle: React.CSSProperties = {
	margin: '2rem',
	padding: '0 1rem'
}

const pageStyle: React.CSSProperties = {
	width: '100vw',
	height: '100vh',
	padding: '1rem',
	boxSizing: 'border-box',
	fontFamily: "ui-monospace, 'SFMono-Regular', Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
	display: 'flex',
	flexDirection: 'column',
	color: '#0f172a',
	background: '#f8fafc'
}

const headerStyle: React.CSSProperties = {
	display: 'flex',
	justifyContent: 'space-between',
	alignItems: 'center',
	marginBottom: '0.85rem'
}

const workspaceStyle: React.CSSProperties = {
	display: 'grid',
	gridTemplateColumns: 'minmax(320px, 36%) 1fr',
	gap: '0.75rem',
	minHeight: 0,
	flex: 1,
	alignItems: 'stretch'
}

const sidebarStyle: React.CSSProperties = {
	border: '1px solid #cbd5e1',
	borderRadius: 10,
	padding: '0.75rem',
	background: '#fff',
	display: 'flex',
	flexDirection: 'column',
	overflow: 'hidden',
	minWidth: 0
}

const editorPaneStyle: React.CSSProperties = {
	border: '1px solid #cbd5e1',
	borderRadius: 10,
	padding: '0.75rem',
	background: '#fff',
	display: 'flex',
	flexDirection: 'column',
	overflow: 'hidden',
	minWidth: 0
}

const searchRowStyle: React.CSSProperties = { display: 'flex', gap: '0.5rem' }

const searchInputStyle: React.CSSProperties = {
	flex: 1,
	padding: '0.55rem',
	border: '1px solid #cbd5e1',
	borderRadius: 8,
	font: 'inherit',
	background: '#fff'
}

const resultsWrapStyle: React.CSSProperties = {
	marginTop: '0.75rem',
	minHeight: 0,
	overflowY: 'auto'
}

const resultsListStyle: React.CSSProperties = {
	margin: 0,
	padding: 0,
	listStyle: 'none',
	display: 'flex',
	flexDirection: 'column',
	gap: '0.5rem'
}

const resultButtonStyle = (active: boolean): React.CSSProperties => ({
	width: '100%',
	textAlign: 'left',
	padding: '0.65rem',
	border: active ? '1px solid #0f172a' : '1px solid #e2e8f0',
	borderRadius: 8,
	background: active ? '#e2e8f0' : '#fff',
	font: 'inherit',
	cursor: 'pointer'
})

const editorFormStyle: React.CSSProperties = {
	height: '100%',
	display: 'flex',
	flexDirection: 'column',
	gap: '0.75rem'
}

const editorHeaderStyle: React.CSSProperties = {
	display: 'flex',
	justifyContent: 'space-between',
	alignItems: 'center',
	gap: '0.5rem'
}

const editorTextStyle: React.CSSProperties = {
	width: '100%',
	flex: 1,
	minHeight: 0,
	padding: '0.75rem',
	border: '1px solid #cbd5e1',
	borderRadius: 8,
	boxSizing: 'border-box',
	font: 'inherit',
	resize: 'none',
	background: '#fff'
}

const editorFooterStyle: React.CSSProperties = {
	display: 'flex',
	justifyContent: 'space-between',
	alignItems: 'center'
}

const buttonStyle: React.CSSProperties = {
	padding: '0.55rem 0.85rem',
	border: '1px solid #0f172a',
	borderRadius: 8,
	background: '#0f172a',
	color: '#fff',
	cursor: 'pointer'
}

const authShellStyle: React.CSSProperties = {
	height: '100vh',
	display: 'grid',
	placeItems: 'center',
	background: '#f8fafc',
	padding: '1rem',
	boxSizing: 'border-box'
}

const authCardStyle: React.CSSProperties = {
	width: 'min(560px, 100%)',
	padding: '1.5rem',
	textAlign: 'center',
	border: '1px solid #cbd5e1',
	borderRadius: 12,
	background: '#fff'
}

export default App
