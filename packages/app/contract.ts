/// <reference lib="dom" />
// New remote-ESM app contract. Apps export a default `App` object; the host
// shell loads the module via `import()` and calls `mount(el, host)`. No
// transport, no JSON-RPC. The shape here is the long-term contract; it
// coexists with the iframe-era exports until the legacy path is deleted.

import Type from 'typebox'
import type { CalendarCapability } from './capabilities/calendar/contract.js'
import type { EmailCapability } from './capabilities/email/contract.js'

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

// Typed map of host capabilities. Extensible via TypeScript declaration
// merging — adding a future capability means augmenting this map plus
// registering a host broker; no transport layer to touch.
//
// ```ts
// declare module '@justfiles/app' {
//   interface AppCapabilityMap { reminders: RemindersCapability }
// }
// ```
export interface AppCapabilityMap {
	email: EmailCapability
	calendar: CalendarCapability
}

// App-facing capabilities object on `Host`. Each entry is a typed broker
// reached through ordinary async method calls — no generic `invoke` wrapper,
// no stringly-typed capability/method names.
export type Capabilities = { readonly [K in keyof AppCapabilityMap]: AppCapabilityMap[K] }

// A tool the app exposes to the host's agent runtime. The schema is a
// TypeBox object; `Type.Static<S>` flows through `handler`'s `input` so
// authors get a typed argument. Input is validated at the host boundary
// (TypeBox `Value.Check`) before the handler runs.
export interface Tool<S extends Type.TSchema = Type.TSchema> {
	readonly name: string
	readonly description: string
	readonly schema: S
	handler(input: Type.Static<S>): unknown | Promise<unknown>
}

export interface ToolRegistry {
	/** Register a tool. Returns an unregister function that is idempotent. */
	register<S extends Type.TSchema>(tool: Tool<S>): () => void
}

// Agent sub-API. Cancellation of in-flight `send` is implicit via
// `unmount()`. The app exposes its current self-description through the
// optional `App.describe()` method, not through the agent — keeps the
// app declarative ("here is how to read me") rather than imperative
// ("call this on the agent").
export interface Agent {
	send(text: string): Promise<string>
	readonly tools: ToolRegistry
}

// Host SDK passed to `mount()`. App authors should thread the `Host`
// instance through their own state (React context, props, closures);
// reading it from a global is no longer supported.
export interface Host {
	readonly version: number
	readonly volume: Volume
	readonly capabilities: Capabilities
	readonly agent: Agent
}

// An app's default export. The entry module must be import-side-effect-free:
// rendering belongs inside `mount()`, not at module load. `describe()` is
// optional — apps that have no live state for the agent to read omit it.
// The host calls it whenever it is about to build agent context; the app
// returns its current self-description, or `null` for "nothing to report
// right now."
export interface App {
	readonly id: string
	mount(el: HTMLElement, host: Host): void | Promise<void>
	unmount(): void | Promise<void>
	describe?(): string | null | Promise<string | null>
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
