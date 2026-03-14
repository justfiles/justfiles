import { useAuth } from '@clerk/clerk-react'
import { useEffect, useState } from 'react'
import './App.css'
import { AuthWall } from './AuthWall'
import { EditorLayout } from './EditorLayout'

const LS_KEY = 'ghostore:draft'

function App() {
	const { getToken, isLoaded, isSignedIn } = useAuth()
	const [editorText, setEditorText] = useState(() => localStorage.getItem(LS_KEY) ?? '')
	const [submitStatus, setSubmitStatus] = useState<string | null>(null)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)

	// Persist draft to localStorage
	useEffect(() => {
		localStorage.setItem(LS_KEY, editorText)
	}, [editorText])

	if (!isLoaded) return <p className="m-8">Loading…</p>
	if (!isSignedIn) return <AuthWall />

	async function handleSubmit() {
		if (!editorText.trim()) return
		setSubmitStatus(null)
		setErrorMessage(null)
		try {
			const token = await getToken()
			if (!token) throw new Error('Missing auth token')
			const res = await fetch('/api/v1/capture', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
				body: JSON.stringify({ text: editorText })
			})
			const data = (await res.json()) as { id: string }
			setEditorText('')
			localStorage.removeItem(LS_KEY)
			setSubmitStatus(`Saved as ${data.id}`)
		} catch {
			setErrorMessage('Error saving memory')
		}
	}

	const header = (
		<button
			type="button"
			onClick={handleSubmit}
			className="w-20 py-1.5 border border-slate-900 rounded-md bg-slate-900 text-white cursor-pointer text-xs font-mono hover:bg-slate-700 transition-colors"
		>
			Submit
		</button>
	)

	return (
		<EditorLayout
			header={header}
			value={editorText}
			onChange={setEditorText}
			minibufferLeft="draft"
			minibufferRight={
				<span className={errorMessage ? 'text-red-600' : ''}>{errorMessage ?? submitStatus}</span>
			}
		/>
	)
}

export default App
