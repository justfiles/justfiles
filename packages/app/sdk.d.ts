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
	/** Read a UTF-8 text file from app-private storage. Rejects with an
	 *  error whose message starts with `ENOENT:` if the file is missing.
	 *  Paths are relative to the app's private root; absolute paths are
	 *  also rooted in that scope. `..` segments are rejected. */
	readText(path: string): Promise<string>
	/** Write a UTF-8 text file to app-private storage. Creates parent
	 *  directories as needed. */
	writeText(path: string, data: string): Promise<void>
	/** Read raw bytes from a file in app-private storage. */
	readFile(path: string): Promise<Uint8Array>
	/** Write raw bytes to a file in app-private storage. The bytes cross
	 *  the host bridge as a base64 string; the SDK encodes/decodes for you. */
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
