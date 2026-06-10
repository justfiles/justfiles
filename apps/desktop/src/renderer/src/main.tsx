import './assets/main.css'

import * as React from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import * as ReactDomClient from 'react-dom/client'
import App from './App'

window.__desktopShared = { react: React, reactDomClient: ReactDomClient, jsxRuntime: JsxRuntime }

const root = document.getElementById('root')
if (root) {
	ReactDomClient.createRoot(root).render(
		<React.StrictMode>
			<App />
		</React.StrictMode>
	)
}
