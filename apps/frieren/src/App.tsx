import { useAuth } from '@clerk/clerk-react'
import { AuthWall } from './AuthWall'
import { ChatPage } from './ChatPage'
import { FilesPage } from './FilesPage'
import { useClientLocation } from './clientRouter'

function App() {
	const { isLoaded, isSignedIn } = useAuth()
	const location = useClientLocation()

	if (!isLoaded) return <p className="m-8">Loading…</p>
	if (!isSignedIn) return <AuthWall />

	if (location.pathname.startsWith('/files')) {
		return <FilesPage search={location.search} />
	}

	return <ChatPage />
}

export default App
