// Author-facing types for the injected `window.app` SDK in client-only apps.
// Mirror of `sdk.js`. App authors `/// <reference types="@justfiles/app/sdk" />`
// or add it to `compilerOptions.types` to get autocomplete on `window.app`.

export interface AppLifecycle {
	/** Register a callback that fires once when the host starts the app.
	 *  If the app has already started, the callback runs in a microtask.
	 *  Returns an unsubscribe function. */
	onStart(callback: () => void): () => void
}

export interface App {
	/** Host SDK API version. Bumped on breaking changes to `window.app`. */
	readonly version: number
	readonly lifecycle: AppLifecycle
}

declare global {
	interface Window {
		readonly app: App
	}
}
