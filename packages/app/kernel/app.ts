import type { Volume } from '@justfiles/fs'
import type { StandardSchemaV1 } from '@standard-schema/spec'

export type Action<Type extends string = string, Params = unknown> = {
	type: Type
	params: Params
	actor?: string
}

export interface App<
	State,
	Schemas extends Record<string, StandardSchemaV1> = Record<string, StandardSchemaV1>
> {
	// Per-action input schemas. The kernel validates against these at the
	// trust boundary before entering the app; the app does no validation.
	// Kept in the type so `typeof app` can drive a typed client.
	schemas: Schemas
	dispatch: (action: Action, ctx: Context<State>) => Promise<State>
}

export interface Context<State = unknown> {
	setState: (state: State) => Promise<void>
	readonly state: State
	files: Volume
}

export interface AppManifest {
	id: string
	name: string
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

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}
