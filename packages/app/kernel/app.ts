import type { Volume } from '@justfiles/fs'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { CapabilityFactory } from '../capabilities/core.ts'

export type Action<Type extends string = string, Params = unknown> = {
	type: Type
	params: Params
	actor?: string
}

export interface ActionExample {
	params: Record<string, unknown>
	description?: string
}

export interface ActionMeta {
	description?: string
	examples?: ActionExample[]
	schemaHint?: unknown
}

type CapabilityRequest<Id extends string = string, Shape = unknown> = ReturnType<
	CapabilityFactory<Id, Shape>
>
type CapabilityRequests = Record<string, CapabilityRequest>
type NoCapabilities = Record<string, never>
type CapabilityInvocation = {
	capability: string
	method: string
	input: unknown
	actor?: string
}
type CapabilityInvoke = (req: CapabilityInvocation) => Promise<unknown>

type ShapeOf<C> = C extends CapabilityRequest<string, infer Shape> ? Shape : never
type InjectedCapabilities<Caps extends CapabilityRequests> = {
	readonly [K in keyof Caps]: ShapeOf<Caps[K]>
}

export interface App<
	State,
	Schemas extends Record<string, StandardSchemaV1> = Record<string, StandardSchemaV1>,
	Caps extends CapabilityRequests = NoCapabilities
> {
	// Per-action input schemas. Carried so `typeof app` drives the typed
	// client (and for host introspection). Validation itself runs in
	// defineApp's dispatch — not here, not in the kernel.
	schemas: Schemas
	actions: Record<keyof Schemas & string, ActionMeta>
	readonly __capabilities?: Caps
	dispatch: (action: Action, ctx: RuntimeContext<State>) => Promise<State>
}

export interface Context<State = unknown, Caps extends CapabilityRequests = NoCapabilities> {
	setState: (state: State) => Promise<void>
	readonly state: State
	files: Volume
	readonly capabilities: InjectedCapabilities<Caps>
}

export interface RuntimeContext<State = unknown> {
	setState: (state: State) => Promise<void>
	readonly state: State
	files: Volume
	capabilityInvoke?: CapabilityInvoke
}

export interface AppManifest {
	id: string
	name: string
	description?: string
	version?: string
	icon?: string
	app: string
	gui?: string
	cli?: string
}

export interface AppBundle {
	manifest(): Promise<AppManifest>
	list(): AsyncIterable<string>
	read(path: string): Promise<Uint8Array>
}

export interface MemoryAppBundle {
	id: string
	name: string
	description?: string
	version?: string
	icon?: string
	app: string
	gui?: string
	cli?: string
	assets?: Record<string, string | Uint8Array>
}

export function appBundleFromMemory(input: MemoryAppBundle): AppBundle {
	const files: Record<string, string | Uint8Array> = {
		'app.js': input.app,
		'gui.js': input.gui ?? '',
		'cli.js': input.cli ?? '',
		...input.assets
	}

	return {
		async manifest() {
			return {
				id: input.id,
				name: input.name,
				description: input.description,
				version: input.version,
				icon: input.icon,
				app: 'app.js',
				gui: 'gui.js',
				cli: 'cli.js'
			}
		},
		async *list() {
			yield* Object.keys(files)
		},
		async read(path) {
			const file = files[path]
			if (file == null) throw new Error(`file not found: ${path}`)
			return typeof file === 'string' ? bytes(file) : file
		}
	}
}

export interface InstalledApp {
	manifest: AppManifest
	read(path: string): Promise<Uint8Array>
}

export function safeBundlePath(path: string): string {
	if (!path || path.includes('\0')) throw new Error(`invalid app bundle path: ${path}`)
	if (path.startsWith('/') || path.startsWith('//')) throw new Error(`invalid app bundle path: ${path}`)
	const parts = path.split('/').filter((part) => part && part !== '.')
	if (parts.length === 0 || parts.some((part) => part === '..')) {
		throw new Error(`invalid app bundle path: ${path}`)
	}
	return parts.join('/')
}

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}
