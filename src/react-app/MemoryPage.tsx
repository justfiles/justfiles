import { useAuth } from '@clerk/clerk-react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { AuthWall } from './AuthWall'
import { EditorLayout } from './EditorLayout'

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

export function MemoryPage() {
	const { id } = useParams({ strict: false }) as { id: string }
	const navigate = useNavigate()
	const { getToken, isLoaded, isSignedIn } = useAuth()
	const [memory, setMemory] = useState<Memory | null>(null)
	const [editorText, setEditorText] = useState('')
	const [loadingMemory, setLoadingMemory] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle')
	const loadedTextRef = useRef<string | null>(null)
	const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken

	useEffect(() => {
		if (!isLoaded || !isSignedIn) return
		async function load() {
			try {
				const token = await getToken()
				if (!token) throw new Error('Missing auth token')
				const res = await fetch(`/api/v1/memory/${encodeURIComponent(id)}`, {
					headers: { Authorization: `Bearer ${token}` }
				})
				if (!res.ok) throw new Error(`Failed: ${res.status}`)
				const data = (await res.json()) as Memory
				setMemory(data)
				setEditorText(data.raw_text)
				loadedTextRef.current = data.raw_text
			} catch {
				setError('Failed to load memory')
			} finally {
				setLoadingMemory(false)
			}
		}
		load()
	}, [isLoaded, isSignedIn, id])

	useEffect(() => {
		if (!memory || editorText === loadedTextRef.current) return
		setAutoSaveStatus('pending')
		if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
		autoSaveTimer.current = setTimeout(async () => {
			setAutoSaveStatus('saving')
			try {
				const token = await getTokenRef.current()
				if (!token) throw new Error('Missing auth token')
				const res = await fetch('/api/v1/update', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
					body: JSON.stringify({ id: memory.id, text: editorText })
				})
				if (!res.ok) throw new Error(`Save failed: ${res.status}`)
				loadedTextRef.current = editorText
				setAutoSaveStatus('saved')
			} catch {
				setAutoSaveStatus('error')
			}
		}, 3000)
	}, [editorText])

	if (!isLoaded) return <p className="m-8">Loading…</p>
	if (!isSignedIn) return <AuthWall />
	if (loadingMemory) return <p className="m-8">Loading memory…</p>
	if (error) return <p className="m-8 text-error">{error}</p>

	const saveLabel =
		autoSaveStatus === 'pending' ? 'Unsaved changes…' :
		autoSaveStatus === 'saving'  ? 'Saving…' :
		autoSaveStatus === 'saved'   ? 'Saved' :
		autoSaveStatus === 'error'   ? 'Save failed' :
		null

	return (
		<EditorLayout
			header={
				<button
					type="button"
					onClick={() => navigate({ to: '/' })}
					className="btn btn-neutral btn-sm font-mono"
				>
					New
				</button>
			}
			value={editorText}
			onChange={setEditorText}
			minibufferLeft={memory?.path}
			minibufferRight={
				<span className={autoSaveStatus === 'saved' ? 'text-success' : autoSaveStatus === 'error' ? 'text-error' : ''}>
					{saveLabel}
				</span>
			}
		/>
	)
}
