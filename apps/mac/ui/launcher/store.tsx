import '@justfiles/design/design.css'
import '@justfiles/design/mac.css'
import { createRoot } from 'react-dom/client'
import { StoreSurface } from './appStore'
import { useSystemApps } from './system'

// The App Store as its own page, for the native launcher: it embeds this in a WKWebView
// over its AppKit chrome, the way it embeds the chat. Same surface the web launcher's store
// tile shows — the only difference is who closes it, so Done posts back to native.

interface StoreWindow {
	webkit?: { messageHandlers?: { store?: { postMessage(message: unknown): void } } }
}

const win = window as unknown as StoreWindow

function StorePage() {
	const { apps } = useSystemApps()
	return (
		<StoreSurface
			installed={apps}
			onClose={() => win.webkit?.messageHandlers?.store?.postMessage('close')}
		/>
	)
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<StorePage />)
