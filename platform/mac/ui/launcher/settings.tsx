import '@justfiles/design/design.css'
import '@justfiles/design/mac.css'
import { Settings } from '@justfiles/ui/Settings'
import { settingsCategory } from '@justfiles/ui/settings/types'
import { createRoot } from 'react-dom/client'

const token = new URLSearchParams(location.search).get('token') ?? ''
const getToken = async () => token
const root = document.getElementById('root')
if (root)
	createRoot(root).render(
		<Settings getToken={getToken} category={settingsCategory(location.hash.slice(1))} />
	)
