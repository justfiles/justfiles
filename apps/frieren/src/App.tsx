import { ChatPage } from './ChatPage'
import { FilesPage } from './FilesPage'
import { useClientLocation } from './clientRouter'

function App() {
	const location = useClientLocation()

	if (location.pathname.startsWith('/files')) {
		return <FilesPage search={location.search} />
	}

	return <ChatPage />
}

export default App
