// Ambient declaration for the build-time virtual module emitted by
// `hostApps()` in `./vite-plugin`. Hosts reference this file via
// `tsconfig.compilerOptions.types: ["@justfiles/app/virtual"]` (or a
// `/// <reference types="@justfiles/app/virtual" />` directive) and can then
// write `import { registry } from 'virtual:@justfiles/apps'` with full types.
//
// The registry holds only manifests — small data that runs at registration
// time. Asset bytes (HTML, JS, CSS, wasm, wad, images) live in the host's
// static-assets layer under `/apps/<id>/<path>` and are streamed via the
// worker's ASSETS binding.

declare module 'virtual:@justfiles/apps' {
	import type { AppPermission } from '@justfiles/app'

	export const registry: ReadonlyMap<
		string,
		{
			manifest: {
				format: 1
				name: string
				description: string
				version: string
				icon?: string
				entry: string
				permissions?: readonly AppPermission[]
			}
		}
	>
}
