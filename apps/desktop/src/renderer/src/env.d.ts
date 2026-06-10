/// <reference types="vite/client" />

import type * as React from 'react'
import type * as JsxRuntime from 'react/jsx-runtime'
import type * as ReactDomClient from 'react-dom/client'

declare global {
	interface Window {
		__desktopShared: {
			react: typeof React
			reactDomClient: typeof ReactDomClient
			jsxRuntime: typeof JsxRuntime
		}
	}
}
