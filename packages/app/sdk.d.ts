// Author-facing types for the injected `window.app` SDK in client-only apps.
// Mirror of `sdk.js`. App authors `/// <reference types="@justfiles/app/sdk" />`
// or add it to `compilerOptions.types` to get autocomplete on `window.app`.

export interface AppLifecycle {
	/** Register a callback that fires once when the host starts the app.
	 *  If the app has already started, the callback runs in a microtask.
	 *  Returns an unsubscribe function. */
	onStart(callback: () => void): () => void
}

export interface AppVolume {
	/** Read a UTF-8 text file from app-private storage. Rejects with
	 *  `code: -32001` (not_found) when the file is missing. */
	readText(path: string): Promise<string>
	/** Write a UTF-8 text file. Parent directories are created as needed. */
	writeText(path: string, text: string): Promise<void>
	/** Read raw bytes from app-private storage. */
	readFile(path: string): Promise<Uint8Array>
	/** Write raw bytes. Parent directories are created as needed. */
	writeFile(path: string, bytes: Uint8Array): Promise<void>
}

export interface App {
	/** Host SDK API version. Bumped on breaking changes to `window.app`. */
	readonly version: number
	readonly lifecycle: AppLifecycle
	readonly volume: AppVolume
}

declare global {
	interface Window {
		readonly app: App
	}
}
