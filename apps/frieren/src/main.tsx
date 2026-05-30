import { ClerkProvider } from '@clerk/clerk-react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerServiceWorker } from './pwa.ts'

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
if (!publishableKey) {
	throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY')
}

const rootElement = document.getElementById('root')
if (!rootElement) {
	throw new Error('Missing root element')
}

createRoot(rootElement).render(
	<StrictMode>
		<ClerkProvider publishableKey={publishableKey}>
			<App />
		</ClerkProvider>
	</StrictMode>
)

registerServiceWorker()
