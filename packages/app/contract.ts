/// <reference lib="dom" />
// New remote-ESM app contract. Apps export a default `App` object; the host
// shell loads the module via `import()` and calls `mount(el, host)`. No
// transport, no JSON-RPC. The shape here is the long-term contract; it
// coexists with the iframe-era exports until the legacy path is deleted.

import Type from 'typebox'

export const APP_CONTRACT_VERSION = 1

// App-facing scoped storage. Paths are app-relative; the host scopes them
// under the app's private storage. Failures throw real `Error` instances
// (with `NotFoundError` for missing files); no JSON-RPC error envelopes.
export interface Volume {
	readText(path: string): Promise<string>
	writeText(path: string, text: string): Promise<void>
	readFile(path: string): Promise<Uint8Array>
	writeFile(path: string, data: Uint8Array): Promise<void>
}

export class NotFoundError extends Error {
	constructor(path: string) {
		super(`not found: ${path}`)
		this.name = 'NotFoundError'
	}
}

// Host SDK passed to `mount()`. `agent` and `capabilities` arrive in later
// slices. App authors should thread the `Host` instance through their own
// state (React context, props, closures); reading it from a global is no
// longer supported.
export interface Host {
	readonly version: number
	readonly volume: Volume
}

// An app's default export. The entry module must be import-side-effect-free:
// rendering belongs inside `mount()`, not at module load.
export interface App {
	readonly id: string
	mount(el: HTMLElement, host: Host): void | Promise<void>
	unmount(): void | Promise<void>
}

// Identity helper for ergonomic typing of `export default defineApp({...})`.
export function defineApp(app: App): App {
	return app
}

// Manifest for the new ESM loader path. Discriminated from the legacy iframe
// manifest by the presence of an `id` field and absence of `format`/`name`.
export const ManifestSchema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 128 }),
	title: Type.String({ minLength: 1, maxLength: 128 }),
	version: Type.String({ minLength: 1 }),
	entry: Type.String({ minLength: 1 }),
	icon: Type.Optional(Type.String({ minLength: 1, maxLength: 256 }))
})
export type Manifest = Type.Static<typeof ManifestSchema>
